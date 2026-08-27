import { db, hydrate } from './db.js';
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

/**
 * Certificate creation is deliberately not an application-facing operation.
 * The execution orchestrator owns the only internal certificate writer. Keep
 * this compatibility stub non-destructive so an old caller cannot complete a
 * case outside an active execution claim.
 */
export function executeCertificate() {
  throw new Error('certificate creation is internal to erasure execution');
}
