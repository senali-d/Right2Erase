import { db, hydrate, now } from './db.js';
import { hashPlan, validateDeletionPlan } from './plan.js';
import { validatePlanIntegrity } from './erasure.js';

/**
 * Stable boundary for destructive system adapters. Adapters must make one call
 * atomic and idempotent for (case_id, plan_hash), and return a JSON value.
 * These deliberately refuse by default: production connectors are supplied by
 * the deployment, never guessed by the case-management service.
 */
export const executionInterfaces = Object.freeze({
  database: async () => { throw new Error('database execution interface is not configured'); },
  minio: async () => { throw new Error('MinIO execution interface is not configured'); },
  billing: async () => { throw new Error('billing execution interface is not configured'); },
});

const systemFor = (system) => {
  const value = String(system).toLowerCase();
  if (['postgres', 'postgresql', 'database', 'db'].includes(value)) return 'database';
  if (['minio', 'storage', 's3'].includes(value)) return 'minio';
  if (value === 'billing') return 'billing';
  return null;
};

function readExecutionState(caseId, planHash, approvedBy) {
  const subject = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!subject) throw new Error(`case not found: ${caseId}`);
  const plan = db.prepare('SELECT * FROM plans WHERE case_id = ? AND plan_hash = ?').get(caseId, planHash);
  if (!plan) throw new Error('plan hash does not match a stored plan for this case');
  let body;
  try { body = JSON.parse(plan.body); } catch { throw new Error('stored plan is not valid JSON'); }
  if (body.case_id !== caseId || plan.plan_hash !== planHash || hashPlan(body) !== planHash) {
    throw new Error('stored plan failed canonical hash validation');
  }
  const latest = db.prepare('SELECT * FROM plans WHERE case_id = ? ORDER BY version DESC LIMIT 1').get(caseId);
  if (!latest || latest.id !== plan.id || plan.case_revision !== subject.revision) {
    throw new Error('plan is stale; create and approve a new plan for the current case revision');
  }
  const approval = db.prepare(`SELECT * FROM approvals
    WHERE case_id = ? AND plan_hash = ? AND case_revision = ?
    ORDER BY id DESC LIMIT 1`).get(caseId, planHash, subject.revision);
  if (!approval) throw new Error('the current plan has not been approved');
  if (approval.approved_by !== approvedBy) throw new Error('approved_by does not match the approving identity');
  if (subject.status === 'completed' || db.prepare('SELECT 1 FROM certificates WHERE case_id = ?').get(caseId)) {
    throw new Error('case already has a certificate');
  }
  if (!Array.isArray(body.actions)) throw new Error('canonical plan actions are invalid');
  const actions = body.actions.map((action) => {
    if (!action || !action.system || !action.record_type || action.record_id == null) {
      throw new Error('canonical plan contains an invalid action');
    }
    const target = systemFor(action.system);
    if (!target) throw new Error(`no execution interface for system: ${action.system}`);
    const disposition = action.disposition || 'erase';
    if (!['erase', 'retain', 'review'].includes(disposition)) throw new Error('canonical plan contains an invalid disposition');
    return { ...action, disposition, target };
  });
  return { subject, plan, body, actions };
}

// This writer is intentionally module-private. The MCP layer and callers of
// erasure.js cannot manufacture a certificate; only this workflow can invoke
// it after its execution claim and adapter phases have completed.
function recordExecutionCertificate({ caseId, planHash, approvedBy, manifest = [], withheld = [] }) {
  const timestamp = now();
  const transaction = db.transaction(() => {
    const subject = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
    if (!subject) throw new Error(`case not found: ${caseId}`);
    if (subject.status !== 'executing') throw new Error('certificate requires an active execution claim');
    const plan = validatePlanIntegrity({ caseId, planHash });
    const latestPlan = db.prepare('SELECT * FROM plans WHERE case_id = ? ORDER BY version DESC LIMIT 1').get(caseId);
    if (!latestPlan || latestPlan.id !== plan.id || plan.case_revision !== subject.revision) {
      throw new Error('plan is stale; create and approve a new plan for the current case revision');
    }
    const approval = db.prepare(`SELECT * FROM approvals
      WHERE case_id = ? AND plan_hash = ? AND case_revision = ?
      ORDER BY id DESC LIMIT 1`).get(caseId, planHash, subject.revision);
    if (!approval) throw new Error('the current plan has not been approved');
    if (approval.approved_by !== approvedBy) throw new Error('approved_by does not match the approving identity');
    if (db.prepare('SELECT 1 FROM certificates WHERE case_id = ?').get(caseId)) {
      throw new Error('case already has a certificate');
    }
    let reviewedPlan;
    try {
      reviewedPlan = typeof plan.body === 'string' ? JSON.parse(plan.body) : plan.body;
    } catch {
      throw new Error('stored plan is malformed');
    }
    validateDeletionPlan(reviewedPlan, manifest, withheld);

    db.prepare(`INSERT INTO certificates (case_id, plan_hash, approved_by, manifest, withheld, executed_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(caseId, planHash, approvedBy, JSON.stringify(manifest), JSON.stringify(withheld), timestamp);
    db.prepare("UPDATE cases SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'executing'").run(timestamp, caseId);
  });
  transaction();
  return hydrate(db.prepare('SELECT * FROM certificates WHERE case_id = ?').get(caseId));
}

/** Execute the only destructive workflow owned by Oubliette. */
export async function oublietteExecuteErasure({ caseId, planHash, approvedBy, interfaces = executionInterfaces }) {
  if (!caseId || !planHash || !approvedBy) throw new Error('case_id, plan_hash, and approved_by are required');
  const initial = readExecutionState(caseId, planHash, approvedBy);
  const grouped = { database: [], minio: [], billing: [] };
  const withheld = [];
  for (const action of initial.actions) {
    if (action.disposition === 'erase') grouped[action.target].push(action);
    else withheld.push(action);
  }

  const eraseManifest = initial.actions.filter((action) => action.disposition === 'erase');
  // Validate the exact deletion/withhold partition before any destructive adapter runs.
  validateDeletionPlan(initial.body, eraseManifest, withheld);

  // Claim the revision before leaving SQLite. Finding writes are not allowed
  // while executing, so an adapter cannot be given a plan that changed later.
  const timestamp = now();
  db.transaction(() => {
    const current = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
    if (!current || current.revision !== initial.subject.revision || current.status === 'completed') {
      throw new Error('case changed before execution; refusing to execute');
    }
    db.prepare("UPDATE cases SET status = 'executing', updated_at = ? WHERE id = ?").run(timestamp, caseId);
  })();

  const systems = {};
  try {
    for (const name of ['database', 'minio', 'billing']) {
      const execute = interfaces?.[name];
      if (grouped[name].length && typeof execute !== 'function') throw new Error(`${name} execution interface is not configured`);
      systems[name] = grouped[name].length
        ? { ok: true, result: await execute({ case_id: caseId, plan_hash: planHash, actions: grouped[name] }) }
        : { ok: true, result: null, skipped: true };
    }
    const certificate = recordExecutionCertificate({ caseId, planHash, approvedBy,
      manifest: eraseManifest, withheld });
    return { case_id: caseId, plan_hash: planHash, approved_by: approvedBy, systems, withheld, certificate };
  } catch (error) {
    db.prepare("UPDATE cases SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'executing'").run(now(), caseId);
    throw error;
  }
}

export function getExecutionState(caseId, planHash, approvedBy) {
  return hydrate(readExecutionState(caseId, planHash, approvedBy).plan);
}
