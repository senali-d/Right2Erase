import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oubliette-plan-'));
process.env.OUBLIETTE_DB_PATH = path.join(directory, 'case.db');

const { addFinding, close, createCase, savePlan, db } = await import('../src/db.js');
const { validatePlanIntegrity } = await import('../src/erasure.js');
const { hashPlan } = await import('../src/plan.js');

const caseId = 'integrity-case';
const planBody = {
  case_id: caseId,
  actions: [{ system: 'billing', record_type: 'customer', record_id: '42', disposition: 'erase' }],
  generated_at: '2025-01-01T00:00:00.000Z',
};
const planHash = hashPlan(planBody);

createCase({ id: caseId, subject_email: 'subject@example.com' });
addFinding(caseId, { system: 'billing', record_type: 'customer', record_id: '42' });
savePlan(caseId, planBody, planHash, 1);

test('validates the reloaded plan body against its supplied hash', () => {
  assert.deepEqual(validatePlanIntegrity({ caseId, planHash }).body, planBody);
});

test('rejects a hash that does not select the stored plan', () => {
  assert.throws(
    () => validatePlanIntegrity({ caseId, planHash: '0'.repeat(64) }),
    /plan hash does not match a stored plan/,
  );
});

test('rejects a plan body altered after it was stored', () => {
  db.prepare('UPDATE plans SET body = ? WHERE case_id = ?').run(JSON.stringify({ ...planBody, actions: [] }), caseId);
  assert.throws(
    () => validatePlanIntegrity({ caseId, planHash }),
    /plan integrity check failed/,
  );
});

test.after(() => {
  close();
  fs.rmSync(directory, { recursive: true, force: true });
});
