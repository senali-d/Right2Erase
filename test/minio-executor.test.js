import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPlan } from '../src/plan.js';
import { createSandboxMinioClient, executeSandboxMinioDeletion } from '../src/minio-executor.js';

function fixture() {
  const plan = { case_id: 'case-1', actions: [
    { system: 'minio', disposition: 'erase', locator: 'uploads/acct_1/avatar.png' },
    { system: 'minio', disposition: 'retain', locator: 'uploads/acct_1/held.pdf' },
    { system: 'postgres', disposition: 'erase', locator: 'account:1' },
  ], generated_at: '2025-01-01T00:00:00.000Z' };
  const removed = [];
  return { plan, removed, client: { removeObject: async (bucket, key) => removed.push([bucket, key]) } };
}

function approved(plan) {
  return { approved: true, plan_hash: hashPlan(plan) };
}

test('rejects default MinIO client construction in production', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => createSandboxMinioClient(), /MinIO deletion client is sandbox-only/);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('rejects default MinIO clients aimed at non-local hosts', () => {
  assert.throws(() => createSandboxMinioClient({ endPoint: 'minio.example.test' }), /non-local MinIO target/);
});

test('deletes only erase MinIO actions after PostgreSQL succeeds', async () => {
  const { plan, removed, client } = fixture();
  const result = await executeSandboxMinioDeletion({
    plan, planHash: hashPlan(plan), approval: approved(plan),
    postgresPhase: { success: true }, client,
  });
  assert.deepEqual(removed, [['shopkart-uploads', 'uploads/acct_1/avatar.png']]);
  assert.deepEqual(result.counts, { requested: 1, deleted: 1, failed: 0 });
  assert.deepEqual(result.results, [{ key: 'uploads/acct_1/avatar.png', status: 'deleted' }]);
});

test('does not call MinIO when PostgreSQL phase fails', async () => {
  const { plan, removed, client } = fixture();
  await assert.rejects(() => executeSandboxMinioDeletion({
    plan, planHash: hashPlan(plan), approval: approved(plan),
    postgresPhase: { success: false }, client,
  }), /successful PostgreSQL/);
  assert.deepEqual(removed, []);
});

test('rejects a withheld object before any deletion', async () => {
  const { plan, removed, client } = fixture();
  await assert.rejects(() => executeSandboxMinioDeletion({
    plan, planHash: hashPlan(plan), approval: approved(plan),
    postgresPhase: { success: true }, withheld: ['uploads/acct_1/avatar.png'], client,
  }), /withheld object/);
  assert.deepEqual(removed, []);
});

test('rejects a tampered plan even with the old approval', async () => {
  const { plan, removed, client } = fixture();
  const tampered = { ...plan, actions: [...plan.actions, { system: 'minio', disposition: 'erase', locator: 'unexpected' }] };
  await assert.rejects(() => executeSandboxMinioDeletion({
    plan: tampered, planHash: hashPlan(plan), approval: approved(plan),
    postgresPhase: { success: true }, client,
  }), /plan hash/);
  assert.deepEqual(removed, []);
});

test('returns a result for each planned object when one delete fails', async () => {
  const { plan, client } = fixture();
  plan.actions.splice(2, 1);
  plan.actions.push({ system: 'minio', disposition: 'erase', locator: 'uploads/acct_1/receipt.pdf' });
  const result = await executeSandboxMinioDeletion({
    plan, planHash: hashPlan(plan), approval: approved(plan),
    postgresPhase: { success: true }, client: {
      removeObject: async (bucket, key) => {
        if (key.endsWith('receipt.pdf')) throw new Error('fixture failure');
        return client.removeObject(bucket, key);
      },
    },
  });
  assert.deepEqual(result.counts, { requested: 2, deleted: 1, failed: 1 });
  assert.equal(result.results[1].status, 'failed');
});
