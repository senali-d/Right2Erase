import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oubliette-billing-'));
process.env.OUBLIETTE_DB_PATH = path.join(directory, 'case.db');
const { createCase, addFinding, close, db, recordApproval, savePlan } = await import('../src/db.js');
const { hashPlan } = await import('../src/plan.js');
const { executeBillingCleanup } = await import('../src/billing-executor.js');

const plan = (actions) => ({ actions });
const options = (actions, overrides = {}) => ({
  caseId: 'case-test', planHash: 'a'.repeat(64), approvedBy: 'reviewer',
  loadContext: () => ({ plan: plan(actions) }),
  postgresTransaction: async (context) => ({ manifest: context.actions }),
  billingErase: async () => ({ erased: true }),
  ...overrides,
});

test('rejects a stored plan whose body no longer matches the approved hash', async () => {
  const caseId = 'stored-body-tampered';
  createCase({ id: caseId, subject_email: 'subject@example.test' });
  addFinding(caseId, { system: 'billing', record_type: 'customer', record_id: 'cus_tampered' });
  const body = {
    case_id: caseId,
    actions: [{ system: 'billing', record_type: 'customer', record_id: 'cus_tampered', disposition: 'erase' }],
    generated_at: '2025-01-01T00:00:00.000Z',
  };
  const planHash = hashPlan(body);
  savePlan(caseId, body, planHash, 1);
  recordApproval(caseId, planHash, 'reviewer', 'reviewed');
  db.prepare('UPDATE plans SET body = ? WHERE case_id = ?').run(JSON.stringify({ ...body, actions: [] }), caseId);

  let postgresCalled = false;
  const result = await executeBillingCleanup({
    caseId, planHash, approvedBy: 'reviewer',
    postgresTransaction: async () => { postgresCalled = true; },
    billingErase: async () => {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /plan integrity check failed/);
  assert.equal(postgresCalled, false);
});

test('rejects an unapproved hash before either executor is called', async () => {
  let postgresCalled = false;
  let billingCalled = false;
  const result = await executeBillingCleanup(options([
    { system: 'billing', record_type: 'customer', record_id: 'cus_1', disposition: 'erase' },
  ], {
    planHash: 'b'.repeat(64),
    loadContext: () => { throw new Error('plan hash does not match a stored plan for this case'); },
    postgresTransaction: () => { postgresCalled = true; },
    billingErase: () => { billingCalled = true; },
  }));
  assert.equal(result.ok, false);
  assert.match(result.error, /plan hash/);
  assert.equal(postgresCalled, false);
  assert.equal(billingCalled, false);
});

test('passes withheld obligations through and never sends them to billing', async () => {
  const transactions = [];
  const erased = [];
  const result = await executeBillingCleanup(options([
    { system: 'billing', record_type: 'customer', record_id: 'cus_keep', disposition: 'retain', metadata: { obligation: 'refund' } },
    { system: 'billing', record_type: 'customer', record_id: 'cus_erase', disposition: 'erase' },
  ], {
    postgresTransaction: async (value) => { transactions.push(value); return { manifest: ['postgres-ok'] }; },
    billingErase: async ({ customerId }) => erased.push(customerId),
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.withheld.map((item) => item.record_id), ['cus_keep']);
  assert.deepEqual(transactions[0].withheld.map((item) => item.record_id), ['cus_keep']);
  assert.deepEqual(erased, ['cus_erase']);
});

test('invokes billing only after a successful PostgreSQL transaction', async () => {
  const order = [];
  const result = await executeBillingCleanup(options([
    { system: 'billing', record_type: 'customer', record_id: 'cus_1', disposition: 'erase' },
  ], {
    postgresTransaction: async () => { order.push('postgres-commit'); return { manifest: [] }; },
    billingErase: async () => order.push('billing'),
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(order, ['postgres-commit', 'billing']);
});

test('returns a structured failure and skips billing when PostgreSQL rolls back', async () => {
  let billingCalled = false;
  const result = await executeBillingCleanup(options([
    { system: 'billing', record_type: 'customer', record_id: 'cus_1', disposition: 'erase' },
  ], {
    postgresTransaction: async () => { throw new Error('postgres transaction rolled back'); },
    billingErase: async () => { billingCalled = true; },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.erased.length, 0);
  assert.match(result.error, /rolled back/);
  assert.equal(billingCalled, false);
});

test.after(() => {
  close();
  fs.rmSync(directory, { recursive: true, force: true });
});
