import test from 'node:test';
import assert from 'node:assert/strict';
import { APPROVAL_REQUIRED_TOOLS, DISCOVERY_TOOLS, createTrueForgeAgent } from './trueforge-agent.js';

test('discovery tools are allowlisted and only Oubliette execution is destructive', () => {
  assert.equal(DISCOVERY_TOOLS.has('db_find_accounts'), true);
  assert.equal(DISCOVERY_TOOLS.has('billing_preview_erase'), true);
  assert.deepEqual([...APPROVAL_REQUIRED_TOOLS], ['oubliette_execute_erasure']);
});

test('agent stops at approval and never executes without consent', async () => {
  const calls = [];
  const agent = createTrueForgeAgent({
    callTool: async (tool, args) => {
      calls.push(tool);
      if (tool === 'plan_approve' || tool === 'oubliette_execute_erasure') throw new Error('must not be called');
      return { case_id: args.case_id || 'case-1', plan_hash: 'a'.repeat(64) };
    },
    requestApproval: async () => false,
  });

  const result = await agent.executeApproved({ case_id: 'case-1', plan_hash: 'a'.repeat(64), approved_by: 'captain' });
  assert.equal(result.awaiting_approval, true);
  assert.equal(result.executed, false);
  assert.deepEqual(calls, []);
});

test('agent approves before invoking the sole destructive tool', async () => {
  const calls = [];
  const agent = createTrueForgeAgent({
    callTool: async (tool) => {
      calls.push(tool);
      return tool === 'plan_approve' ? { approved: true } : { certificate: { case_id: 'case-1' } };
    },
    requestApproval: async () => true,
  });

  const result = await agent.executeApproved({ case_id: 'case-1', plan_hash: 'a'.repeat(64), approved_by: 'captain' });
  assert.equal(result.executed, true);
  assert.deepEqual(calls, ['plan_approve', 'oubliette_execute_erasure']);
});
