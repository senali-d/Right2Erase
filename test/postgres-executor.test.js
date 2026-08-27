import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresExecutor } from '../src/postgres-executor.js';

function fakePool({ failOn } = {}) {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0 };
      const table = sql.match(/DELETE FROM (\w+)/)?.[1];
      if (table === failOn) throw new Error(`failure in ${table}`);
      return { rowCount: 1, rows: [{ id: 1 }] };
    },
    release() {},
  };
  return { calls, async connect() { return client; } };
}

const plan = {
  actions: [
    { record_type: 'account', record_id: 1 },
    { record_type: 'order', record_id: 1 },
    { record_type: 'order_item', record_id: 1 },
    { record_type: 'refund', record_id: 1 },
    { record_type: 'support_ticket', record_id: 1 },
    { record_type: 'upload', record_id: 1 },
    { record_type: 'account_email', record_id: 1 },
    { record_type: 'event_log', record_id: 1 },
  ],
};

test('deletes explicit records in leaf-to-root order and returns counts', async () => {
  const pool = fakePool();
  const result = await createPostgresExecutor({ pool }).execute(plan);
  assert.deepEqual(result, {
    order_items: 1, refunds: 1, orders: 1, support_tickets: 1,
    uploads: 1, account_emails: 1, event_log: 1, accounts: 1,
  });
  const deletes = pool.calls.filter((call) => call.startsWith('DELETE')).map((call) => call.match(/DELETE FROM (\w+)/)[1]);
  assert.deepEqual(deletes, ['order_items', 'refunds', 'orders', 'support_tickets', 'uploads', 'account_emails', 'event_log', 'accounts']);
  assert.equal(pool.calls.at(-1), 'COMMIT');
});

test('accepts a full multi-system plan and executes only PostgreSQL actions', async () => {
  const pool = fakePool();
  const result = await createPostgresExecutor({ pool }).execute({
    case_id: 'case-1',
    actions: [
      { system: 'postgres', record_type: 'account', record_id: 1 },
      { system: 'minio', record_type: 'object', record_id: 'uploads/1', locator: 'uploads/1' },
      { system: 'billing', record_type: 'customer', record_id: 'cus_1' },
    ],
  });
  assert.deepEqual(result, { accounts: 1 });
  assert.deepEqual(pool.calls.filter((call) => call.startsWith('DELETE')).map((call) => call.match(/DELETE FROM (\w+)/)[1]), ['accounts']);
});

test('rolls back the whole PostgreSQL operation on any failure', async () => {
  const pool = fakePool({ failOn: 'orders' });
  await assert.rejects(createPostgresExecutor({ pool }).execute(plan), /failure in orders/);
  assert.equal(pool.calls.at(-1), 'ROLLBACK');
  assert.equal(pool.calls.includes('COMMIT'), false);
});

test('does not execute withheld records', async () => {
  const pool = fakePool();
  const result = await createPostgresExecutor({ pool }).execute({
    actions: [{ record_type: 'retained_refund', record_id: 9 }],
    withhold: [{ table: 'retained_refunds', id: 9 }],
  });
  assert.deepEqual(result, {});
  assert.deepEqual(pool.calls, ['BEGIN', 'COMMIT']);
});

test('rejects a planned withheld refund before opening a transaction', async () => {
  const pool = fakePool();
  await assert.rejects(
    createPostgresExecutor({ pool }).execute({
      actions: [{ record_type: 'refund', record_id: 9 }],
      withhold: [{ table: 'refunds', id: 9 }],
    }),
    /withheld record is not deletable/,
  );
  assert.equal(pool.calls.length, 0);
});
