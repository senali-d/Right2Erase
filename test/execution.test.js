import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

const directory = fs.mkdtempSync(`${os.tmpdir()}/oubliette-test-`);
process.env.OUBLIETTE_DB_PATH = `${directory}/cases.db`;
const { createCase, addFinding, savePlan, recordApproval, close } = await import('../src/db.js');
const { buildPlan, hashPlan } = await import('../src/plan.js');
const { oublietteExecuteErasure } = await import('../src/execution.js');
const { executeCertificate } = await import('../src/erasure.js');

function approvedCase(id, findings) {
  createCase({ id, subject_email: `${id}@example.test` });
  for (const finding of findings) addFinding(id, finding);
  const body = buildPlan({ case_id: id, findings });
  const planHash = hashPlan(body);
  savePlan(id, body, planHash,  findings.length);
  recordApproval(id, planHash, 'human@example.test', 'reviewed');
  return { body, planHash };
}

test('certificate creation cannot be invoked outside execution', () => {
  assert.throws(
    () => executeCertificate({ caseId: 'not-executing', planHash: 'a'.repeat(64), approvedBy: 'human@example.test' }),
    /certificate creation is internal/,
  );
});

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
  assert.equal(result.certificate.manifest.length, 3);
  assert.deepEqual(result.certificate.manifest.map((item) => item.system), ['postgres', 'minio', 'billing']);
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

test('does not run downstream systems after PostgreSQL failure and marks execution failed', async () => {
  const { planHash } = approvedCase('postgres-failure', [
    { system: 'postgres', record_type: 'account', record_id: 8, disposition: 'erase' },
    { system: 'minio', record_type: 'object', record_id: 'uploads/b', disposition: 'erase' },
    { system: 'billing', record_type: 'customer', record_id: 'cus_8', disposition: 'erase' },
  ]);
  const calls = [];
  await assert.rejects(oublietteExecuteErasure({ caseId: 'postgres-failure', planHash, approvedBy: 'human@example.test', interfaces: {
    database: async () => { calls.push('database'); throw new Error('rollback'); },
    minio: async () => { calls.push('minio'); },
    billing: async () => { calls.push('billing'); },
  }}), /rollback/);
  assert.deepEqual(calls, ['database']);
  assert.equal((await import('../src/db.js')).getCase('postgres-failure').status, 'failed');
});

test('rejects delete/withhold overlap before any adapter runs', async () => {
  const { body, planHash } = approvedCase('overlap', [
    { system: 'billing', record_type: 'customer', record_id: 'cus_overlap', disposition: 'erase' },
  ]);
  body.actions.push({ ...body.actions[0], disposition: 'retain' });
  const called = [];
  const { db } = await import('../src/db.js');
  const overlappingHash = hashPlan(body);
  db.prepare('UPDATE plans SET body = ?, plan_hash = ? WHERE plan_hash = ?').run(JSON.stringify(body), overlappingHash, planHash);
  db.prepare('UPDATE approvals SET plan_hash = ? WHERE plan_hash = ?').run(overlappingHash, planHash);
  await assert.rejects(oublietteExecuteErasure({ caseId: 'overlap', planHash: overlappingHash, approvedBy: 'human@example.test', interfaces: { billing: async () => called.push(1) } }), /duplicate or overlapping/);
  assert.deepEqual(called, []);
});

test.after(() => close());
