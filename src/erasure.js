import { db, hydrate, now } from './db.js';
import { hashPlan, validateDeletionPlan } from './plan.js';

/**
 * Reload and verify the exact plan selected for execution.
 *
 * The database row is intentionally read again at execution time. Checking
 * both the supplied hash and the hash recorded with the row catches a plan
 * whose body was changed after approval, as well as a caller selecting a
 * different (or unknown) plan hash.
 */
export function validatePlanIntegrity({ caseId, planHash }) {
  const storedPlan = db.prepare('SELECT * FROM plans WHERE case_id = ? AND plan_hash = ?').get(caseId, planHash);
  if (!storedPlan) throw new Error('plan hash does not match a stored plan for this case');

  let body;
  try {
    body = JSON.parse(storedPlan.body);
  } catch {
    throw new Error('stored plan body is invalid');
  }
  const recomputedHash = hashPlan(body);
  if (recomputedHash !== planHash || recomputedHash !== storedPlan.plan_hash) {
    throw new Error('plan integrity check failed; stored plan body does not match its hash');
  }
  return hydrate(storedPlan);
}

export function executeCertificate({ caseId, planHash, approvedBy, manifest = [], withheld = [] }) {
  const timestamp = now();
  const transaction = db.transaction(() => {
    // Re-read all state in the write transaction so a concurrent finding or
    // plan change cannot race the certificate validation.
    const subject = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
    if (!subject) throw new Error(`case not found: ${caseId}`);
<<<<<<< HEAD
    const plan = validatePlanIntegrity({ caseId, planHash });
=======
    const plan = db.prepare('SELECT * FROM plans WHERE case_id = ? AND plan_hash = ?').get(caseId, planHash);
    if (!plan) throw new Error('plan hash does not match a stored plan for this case');
    const body = JSON.parse(plan.body);
    if (body.case_id !== caseId || hashPlan(body) !== planHash || plan.plan_hash !== planHash) {
      throw new Error('stored plan failed canonical hash validation');
    }
>>>>>>> c9c54d5 (Implement Oubliette erasure execution orchestration)
    const latestPlan = db.prepare('SELECT * FROM plans WHERE case_id = ? ORDER BY version DESC LIMIT 1').get(caseId);
    if (!latestPlan || latestPlan.id !== plan.id || plan.case_revision !== subject.revision) {
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

    let reviewedPlan;
    try {
      reviewedPlan = JSON.parse(plan.body);
    } catch {
      throw new Error('stored plan is malformed');
    }
    validateDeletionPlan(reviewedPlan, manifest, withheld);

    db.prepare(`INSERT INTO certificates (case_id, plan_hash, approved_by, manifest, withheld, executed_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(caseId, planHash, approvedBy, JSON.stringify(manifest), JSON.stringify(withheld), timestamp);
    db.prepare("UPDATE cases SET status = 'completed', updated_at = ? WHERE id = ?").run(timestamp, caseId);
  });
  transaction();
  return hydrate(db.prepare('SELECT * FROM certificates WHERE case_id = ?').get(caseId));
}
