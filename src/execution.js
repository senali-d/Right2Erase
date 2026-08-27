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

const databaseTableFor = new Map([
  ['order_item', 'order_items'], ['order_items', 'order_items'],
  ['refund', 'refunds'], ['refunds', 'refunds'], ['order', 'orders'], ['orders', 'orders'],
  ['support_ticket', 'support_tickets'], ['support_tickets', 'support_tickets'],
  ['upload', 'uploads'], ['uploads', 'uploads'], ['account_email', 'account_emails'],
  ['account_emails', 'account_emails'], ['event', 'event_log'], ['event_log', 'event_log'],
  ['account', 'accounts'], ['accounts', 'accounts'],
]);

function objectKey(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value.key || value.object_key || null;
  return null;
}

function resultFailure(result) {
  return result == null || result.ok === false || result.success === false
    || Number(result.failed) > 0 || Number(result.counts?.failed) > 0
    || (Array.isArray(result.results) && result.results.some((item) => item?.status !== 'deleted'));
}

function confirmedActions(system, actions, result) {
  if (resultFailure(result)) throw new Error(`${system} execution did not confirm successful deletion`);
  if (typeof result.deleted === 'number') {
    if (result.deleted !== actions.length) throw new Error(`${system} execution returned an incomplete deletion result`);
    return actions;
  }

  if (system === 'database') {
    const counts = result.counts || result;
    const expected = new Map();
    for (const action of actions) {
      const table = databaseTableFor.get(action.record_type);
      if (!table) throw new Error(`database execution returned an unsupported record type: ${action.record_type}`);
      expected.set(table, (expected.get(table) || 0) + 1);
    }
    if ([...expected].some(([table, count]) => counts?.[table] !== count)) {
      throw new Error('database execution returned incomplete deletion counts');
    }
    return actions;
  }

  if (system === 'minio' && Array.isArray(result.results)) {
    const deleted = new Set(result.results.filter((item) => item?.status === 'deleted').map((item) => objectKey(item.key)));
    const expected = new Set(actions.map((action) => objectKey(action.locator)));
    if (deleted.size !== expected.size || [...expected].some((key) => !key || !deleted.has(key))) {
      throw new Error('minio execution returned incomplete deletion results');
    }
    return actions;
  }

  if (system === 'billing' && Array.isArray(result.erased)) {
    const erased = new Set(result.erased.map(String));
    const expected = new Set(actions.map((action) => String(action.record_id)));
    if (erased.size !== expected.size || [...expected].some((id) => !erased.has(id))) {
      throw new Error('billing execution returned incomplete deletion results');
    }
    return actions;
  }

  throw new Error(`${system} execution did not return confirmed deletions`);
}

function loadExecutionPhase(caseId, planHash, system) {
  const row = db.prepare(`SELECT result, manifest FROM execution_phases
    WHERE case_id = ? AND plan_hash = ? AND system = ?`).get(caseId, planHash, system);
  if (!row) return null;
  return { result: JSON.parse(row.result), manifest: JSON.parse(row.manifest) };
}

function saveExecutionPhase(caseId, planHash, system, result, manifest) {
  db.prepare(`INSERT INTO execution_phases
    (case_id, plan_hash, system, result, manifest, completed_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(case_id, plan_hash, system) DO UPDATE SET
      result = excluded.result, manifest = excluded.manifest, completed_at = excluded.completed_at`)
    .run(caseId, planHash, system, JSON.stringify(result ?? null), JSON.stringify(manifest), now());
}

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
  return { subject, plan, body, actions, approval };
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
    if (!current || current.revision !== initial.subject.revision
        || !['approved', 'failed'].includes(current.status)) {
      throw new Error(current?.status === 'executing'
        ? 'case is already executing'
        : 'case changed before execution; refusing to execute');
    }
    const run = db.prepare('SELECT * FROM execution_runs WHERE case_id = ? AND plan_hash = ?').get(caseId, planHash);
    if (run?.status === 'executing') throw new Error('case is already executing');
    if (run?.status === 'completed') throw new Error('execution has already completed for this plan');
    if (run) {
      db.prepare('UPDATE execution_runs SET status = \'executing\', approved_by = ?, updated_at = ? WHERE id = ?')
        .run(approvedBy, timestamp, run.id);
    } else {
      db.prepare(`INSERT INTO execution_runs (case_id, plan_hash, approved_by, status, created_at, updated_at)
        VALUES (?, ?, ?, 'executing', ?, ?)`).run(caseId, planHash, approvedBy, timestamp, timestamp);
    }
    db.prepare("UPDATE cases SET status = 'executing', updated_at = ? WHERE id = ?").run(timestamp, caseId);
  })();

  const systems = {};
  const confirmedManifest = [];
  try {
    for (const name of ['database', 'minio', 'billing']) {
      const adapter = interfaces?.[name];
      const execute = typeof adapter === 'function' ? adapter : adapter?.execute;
      if (grouped[name].length && typeof execute !== 'function') throw new Error(`${name} execution interface is not configured`);
      const savedPhase = loadExecutionPhase(caseId, planHash, name);
      if (savedPhase) {
        confirmedManifest.push(...savedPhase.manifest);
        systems[name] = { ok: true, result: savedPhase.result, resumed: true };
        continue;
      }
      if (!grouped[name].length) {
        saveExecutionPhase(caseId, planHash, name, null, []);
        systems[name] = { ok: true, result: null, skipped: true };
        continue;
      }
      const result = await execute.call(adapter, {
        // The top-level envelope is the approved full plan. This is required by
        // the PostgreSQL adapter and prevents an adapter from seeing a partial
        // plan that was reconstructed from one system's action group.
        ...initial.body,
        case_id: caseId,
        caseId,
        plan_hash: planHash,
        planHash,
        approved_by: approvedBy,
        approvedBy,
        plan: initial.body,
        approval: initial.approval,
        grouped_actions: grouped[name],
        withheld,
        client: interfaces.minioClient || interfaces.minio?.client,
        postgresTransaction: interfaces.postgresTransaction || interfaces.billing?.postgresTransaction,
        billingErase: interfaces.billingErase || interfaces.billing?.billingErase,
        postgresPhase: systems.database?.ok ? { success: true, result: systems.database.result } : null,
      });
      const confirmed = confirmedActions(name, grouped[name], result);
      saveExecutionPhase(caseId, planHash, name, result, confirmed);
      confirmedManifest.push(...confirmed);
      systems[name] = { ok: true, result };
    }
    const certificate = recordExecutionCertificate({ caseId, planHash, approvedBy,
      manifest: confirmedManifest, withheld });
    db.prepare("UPDATE execution_runs SET status = 'completed', updated_at = ? WHERE case_id = ? AND plan_hash = ? AND status = 'executing'")
      .run(now(), caseId, planHash);
    return { case_id: caseId, plan_hash: planHash, approved_by: approvedBy, systems, withheld, certificate };
  } catch (error) {
    const failedAt = now();
    db.transaction(() => {
      db.prepare("UPDATE cases SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'executing'").run(failedAt, caseId);
      db.prepare("UPDATE execution_runs SET status = 'failed', updated_at = ? WHERE case_id = ? AND plan_hash = ? AND status = 'executing'")
        .run(failedAt, caseId, planHash);
    })();
    throw error;
  }
}

export function getExecutionState(caseId, planHash, approvedBy) {
  return hydrate(readExecutionState(caseId, planHash, approvedBy).plan);
}
