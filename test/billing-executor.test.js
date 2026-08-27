import test from 'node:test';
import assert from 'node:assert/strict';
import { executeBillingCleanup } from '../src/billing-executor.js';

const plan = (actions) => ({ actions });
const options = (actions, overrides = {}) => ({
  caseId: 'case-test', planHash: 'a'.repeat(64), approvedBy: 'reviewer',
  loadContext: () => ({ plan: plan(actions) }),
  postgresTransaction: async (context) => ({ manifest: context.actions }),
  billingErase: async () => ({ erased: true }),
  ...overrides,
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
