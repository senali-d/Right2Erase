import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oubliette-mcp-'));
process.env.OUBLIETTE_DB_PATH = path.join(directory, 'case.db');
const { createRealExecutionInterfaces } = await import('../src/mcp-server.js');
const { hashPlan } = await import('../src/plan.js');

 test('real MCP execution adapters invoke the destructive implementations', async () => {
  const plan = {
    case_id: 'mcp-case',
    actions: [
      { system: 'postgres', record_type: 'account', record_id: 7, disposition: 'erase' },
      { system: 'minio', record_type: 'object', record_id: 'uploads/7/avatar', locator: 'uploads/7/avatar', disposition: 'erase' },
      { system: 'billing', record_type: 'customer', record_id: 'cus_7', disposition: 'erase' },
    ],
    generated_at: '2025-01-01T00:00:00.000Z',
  };
  const planHash = hashPlan(plan);
  const removed = [];
  const erased = [];
  let receivedPlan;
  const interfaces = createRealExecutionInterfaces({
    postgresExecutor: { execute: async (value) => { receivedPlan = value; return { deleted: 1 }; } },
    minioClient: { removeObject: async (bucket, key) => removed.push([bucket, key]) },
    billingErase: async ({ customerId }) => erased.push(customerId),
  });

  await interfaces.database({ plan, case_id: plan.case_id, actions: plan.actions, withheld: [] });
  assert.deepEqual(receivedPlan.actions, plan.actions);
  await interfaces.minio({
    plan, planHash, approval: { plan_hash: planHash, approved: true },
    postgresPhase: { success: true }, withheld: [],
  });
  const result = await interfaces.billing({
    plan, planHash, caseId: plan.case_id, approvedBy: 'reviewer',
    approval: { plan_hash: planHash, approved_by: 'reviewer' }, postgresPhase: { success: true },
  });
  assert.deepEqual(removed, [['shopkart-uploads', 'uploads/7/avatar']]);
  assert.deepEqual(erased, ['cus_7']);
  assert.equal(result.ok, true);
});

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
