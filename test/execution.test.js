import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

const directory = fs.mkdtempSync(`${os.tmpdir()}/oubliette-test-`);
process.env.OUBLIETTE_DB_PATH = `${directory}/cases.db`;
const { createCase, addFinding, savePlan, recordApproval, close } = await import('../src/db.js');
const { buildPlan, hashPlan } = await import('../src/plan.js');
const { oublietteExecuteErasure } = await import('../src/execution.js');

function approvedCase(id, findings) {
  createCase({ id, subject_email: `${id}@example.test` });
  for (const finding of findings) addFinding(id, finding);
  const body = buildPlan({ case_id: id, findings });
  const planHash = hashPlan(body);
  savePlan(id, body, planHash,  findings.length);
  recordApproval(id, planHash, 'human@example.test', 'reviewed');
  return { body, planHash };
}

test('orchestrates all systems and certifies withheld actions', async () => {
  const findings = [
    { system: 'postgres', record_type: 'account', record_id: 7, disposition: 'erase' },
    { system: 'minio', record_type: 'object', record_id: 'uploads/a', disposition: 'erase' },
    { system: 'billing', record_type: 'customer', record_id: 'cus_7', disposition: 'erase' },
    { system: 'postgres', record_type: 'refund', record_id: 9, disposition: 'retain' },
  ];
  const { planHash } = approvedCase('success', findings);
  const calls = [];
  const interfaces = Object.fromEntries(['database', 'minio', 'billing'].map((name) => [name, async (input) => {
    calls.push([name, input]);
    return { deleted: input.actions.length };
  }]));
  const result = await oublietteExecuteErasure({ caseId: 'success', planHash, approvedBy: 'human@example.test', interfaces });
  assert.deepEqual(calls.map(([name]) => name), ['database', 'minio', 'billing']);
  assert.equal(result.withheld.length, 1);
  assert.equal(result.certificate.plan_hash, planHash);
  assert.deepEqual(result.certificate.manifest, result.systems);
});

test('refuses an unapproved or non-canonical plan before adapters run', async () => {
  const { planHash } = approvedCase('refusal', [{ system: 'billing', record_type: 'customer', record_id: 'cus_x' }]);
  const called = [];
  await assert.rejects(
    oublietteExecuteErasure({ caseId: 'refusal', planHash: 'a'.repeat(64), approvedBy: 'human@example.test', interfaces: { billing: async () => called.push(1) } }),
    /plan hash does not match/,
  );
  assert.deepEqual(called, []);
  await assert.rejects(
    oublietteExecuteErasure({ caseId: 'refusal', planHash, approvedBy: 'other@example.test', interfaces: { billing: async () => called.push(1) } }),
    /approved_by does not match/,
  );
  assert.deepEqual(called, []);
});

test.after(() => close());
