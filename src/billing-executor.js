/**
 * Execute the billing part of an approved erasure plan.
 *
 * The billing capability is deliberately injected.  This keeps the irreversible
 * API behind a small interface and makes it impossible for this module to
 * discover (and consequently erase) billing records on its own.
 */
async function contextFromDatabase(caseId, planHash, approvedBy) {
  const { db } = await import('./db.js');
  return contextFromDatabaseWith(db, caseId, planHash, approvedBy);
}

function readJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

async function contextFromDatabaseWith(db, caseId, planHash, approvedBy) {
  const { validatePlanIntegrity } = await import('./erasure.js');
  const subject = db.prepare('SELECT id, revision, status FROM cases WHERE id = ?').get(caseId);
  if (!subject) throw new Error(`case not found: ${caseId}`);
  const plan = validatePlanIntegrity({ caseId, planHash, database: db });
  const latest = db.prepare('SELECT * FROM plans WHERE case_id = ? ORDER BY version DESC LIMIT 1').get(caseId);
  if (!latest || latest.id !== plan.id || plan.case_revision !== subject.revision) {
    throw new Error('plan is stale; create and approve a new plan for the current case revision');
  }
  const approval = db.prepare(`SELECT * FROM approvals
    WHERE case_id = ? AND plan_hash = ? AND case_revision = ? AND approved_by = ?
    ORDER BY id DESC LIMIT 1`).get(caseId, planHash, subject.revision, approvedBy);
  if (!approval) throw new Error('the current plan has not been approved by approvedBy');
  return { plan: readJson(plan.body), approval };
}

function plannedBillingRecords(plan) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  return actions.filter((action) => action?.system === 'billing' && action?.record_type === 'customer');
}

async function loadBillingProgress(caseId, planHash, customerId) {
  const { db } = await import('./db.js');
  const row = db.prepare(`SELECT status, result, error FROM billing_progress
    WHERE case_id = ? AND plan_hash = ? AND customer_id = ?`).get(caseId, planHash, customerId);
  if (!row) return null;
  return { ...row, result: readJson(row.result) };
}

async function saveBillingProgress({ caseId, planHash, customerId, status, result = null, error = null }) {
  const { db, now } = await import('./db.js');
  db.prepare(`INSERT INTO billing_progress
    (case_id, plan_hash, customer_id, status, result, error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(case_id, plan_hash, customer_id) DO UPDATE SET
      status = excluded.status, result = excluded.result, error = excluded.error,
      updated_at = excluded.updated_at`)
    .run(caseId, planHash, customerId, status, JSON.stringify(result), error, now());
}

async function loadBillingTransaction(caseId, planHash) {
  const { db } = await import('./db.js');
  const row = db.prepare(`SELECT status, result FROM billing_transactions
    WHERE case_id = ? AND plan_hash = ?`).get(caseId, planHash);
  return row ? { ...row, result: readJson(row.result) } : null;
}

async function saveBillingTransaction({ caseId, planHash, status, result = null }) {
  const { db, now } = await import('./db.js');
  db.prepare(`INSERT INTO billing_transactions
    (case_id, plan_hash, status, result, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(case_id, plan_hash) DO UPDATE SET
      status = excluded.status, result = excluded.result, updated_at = excluded.updated_at`)
    .run(caseId, planHash, status, JSON.stringify(result), now());
}

/**
 * @param {object} options
 * @param {string} options.caseId
 * @param {string} options.planHash exact hash approved for this case
 * @param {string} options.approvedBy approving identity
 * @param {(context: object) => Promise<object>|object} options.postgresTransaction
 *   Performs the PostgreSQL cleanup and resolves only after COMMIT.
 * @param {(request: {customerId: string, caseId: string, planHash: string}) => Promise<object>|object} options.billingErase
 * @param {(caseId: string, planHash: string, approvedBy: string) => object} [options.loadContext]
 * @returns {Promise<object>} a structured, non-throwing execution result
 */
export async function executeBillingCleanup({
  caseId, planHash, approvedBy, postgresTransaction, billingErase, loadContext = contextFromDatabase,
  loadProgress = loadBillingProgress, saveProgress = saveBillingProgress,
  loadTransactionProgress = loadBillingTransaction, saveTransactionProgress = saveBillingTransaction,
}) {
  const result = { ok: false, caseId, planHash, erased: [], withheld: [], error: null };
  try {
    if (typeof postgresTransaction !== 'function') throw new Error('postgresTransaction is required');
    if (typeof billingErase !== 'function') throw new Error('billingErase is required');
    if (typeof planHash !== 'string' || planHash.length !== 64) throw new Error('a valid approved plan hash is required');

    const context = await loadContext(caseId, planHash, approvedBy);
    const records = plannedBillingRecords(context.plan);
    if (!records.length) throw new Error('approved plan contains no billing customer records');

    const erase = records.filter((record) => record.disposition === 'erase');
    result.withheld = records
      .filter((record) => record.disposition !== 'erase')
      .map((record) => ({ ...record, preserved: true }));
    if (erase.some((record) => record.record_id === undefined || record.record_id === null || String(record.record_id) === '')) {
      throw new Error('every planned billing customer must have a record_id');
    }
    if (!erase.length) throw new Error('approved plan contains no billing customers to erase');

    // This callback is the only place source-system deletion may happen.  Do
    // not move billingErase above it: a rollback must never be followed by a
    // destructive call to the external billing system.
    const committedTransaction = await loadTransactionProgress(caseId, planHash);
    const transactionResult = committedTransaction?.status === 'committed'
      ? committedTransaction.result
      : await postgresTransaction({ caseId, planHash, actions: erase, withheld: result.withheld });
    if (!committedTransaction || committedTransaction.status !== 'committed') {
      await saveTransactionProgress({ caseId, planHash, status: 'committed', result: transactionResult });
    }
    result.manifest = transactionResult?.manifest ?? transactionResult ?? null;

    for (const record of erase) {
      const customerId = String(record.record_id);
      const progress = await loadProgress(caseId, planHash, customerId);
      if (progress?.status === 'deleted') {
        result.erased.push(customerId);
        continue;
      }

      try {
        const response = await billingErase({ customerId, caseId, planHash });
        if (response?.ok === false || response?.success === false || response?.erased === false) {
          throw new Error(`billing deletion failed for customer ${customerId}`);
        }
        await saveProgress({ caseId, planHash, customerId, status: 'deleted', result: response });
        result.erased.push(customerId);
      } catch (error) {
        try {
          await saveProgress({ caseId, planHash, customerId, status: 'failed', error: error instanceof Error ? error.message : String(error) });
        } catch { /* preserve the source-system failure */ }
        throw error;
      }
    }
    result.ok = true;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}

export { plannedBillingRecords };
