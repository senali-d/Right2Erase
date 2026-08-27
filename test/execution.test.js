import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

const directory = fs.mkdtempSync(`${os.tmpdir()}/oubliette-test-`);
process.env.OUBLIETTE_DB_PATH = `${directory}/cases.db`;
const { createCase, addFinding, savePlan, recordApproval, getCase, db, now, close } = await import('../src/db.js');
const { buildPlan, hashPlan } = await import('../src/plan.js');
const { oublietteExecuteErasure } = await import('../src/execution.js');
const { createRealExecutionInterfaces } = await import('../src/mcp-server.js');
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
    return { deleted: input.grouped_actions.length };
  }]));
  const result = await oublietteExecuteErasure({ caseId: 'success', planHash, approvedBy: 'human@example.test', interfaces });
  assert.deepEqual(calls.map(([name]) => name), ['database', 'minio', 'billing']);
  assert.equal(result.withheld.length, 1);
  assert.equal(result.certificate.plan_hash, planHash);
  assert.equal(result.certificate.manifest.length, 3);
  assert.deepEqual(result.certificate.manifest.map((item) => item.system), ['postgres', 'minio', 'billing']);
  assert.equal(getCase('success').status, 'completed');
  assert.equal(db.prepare('SELECT status FROM execution_runs WHERE case_id = ? AND plan_hash = ?').get('success', planHash).status, 'completed');
});

test('normalizes every MinIO alias and case variant after the database phase commits', async () => {
  const aliases = ['minio', 'MINIO', 'MiNiO', 'storage', 'STORAGE', 'StOrAgE', 's3', 'S3'];
  const findings = [
    { system: 'postgres', record_type: 'account', record_id: 21, disposition: 'erase' },
    ...aliases.map((system, index) => ({
      system, record_type: 'object', record_id: `uploads/alias-${index}`,
      locator: `uploads/alias-${index}`, disposition: 'erase',
    })),
  ];
  const { planHash } = approvedCase('minio-aliases', findings);
  const removed = [];
  const interfaces = createRealExecutionInterfaces({
    postgresExecutor: { execute: async () => ({ deleted: 1 }) },
    minioClient: { removeObject: async (bucket, key) => {
      // The production adapter runs after the committed database phase.
      assert.ok(db.prepare(`SELECT 1 FROM execution_phases
        WHERE case_id = ? AND plan_hash = ? AND system = 'database'`).get('minio-aliases', planHash));
      removed.push([bucket, key]);
    } },
  });

  const result = await oublietteExecuteErasure({
    caseId: 'minio-aliases', planHash, approvedBy: 'human@example.test', interfaces,
  });
  assert.deepEqual(removed, aliases.map((_, index) => ['shopkart-uploads', `uploads/alias-${index}`]));
  assert.equal(result.certificate.manifest.length, findings.length);
  assert.equal(getCase('minio-aliases').status, 'completed');
});

test('real billing execution accepts case-insensitive billing system values', async () => {
  const { planHash } = approvedCase('billing-case-insensitive', [
    { system: 'BiLlInG', record_type: 'customer', record_id: 'cus_case-insensitive', disposition: 'erase' },
  ]);
  const erased = [];
  const interfaces = createRealExecutionInterfaces({
    billingErase: async ({ customerId }) => {
      erased.push(customerId);
      return { ok: true, erased: true };
    },
  });

  const result = await oublietteExecuteErasure({
    caseId: 'billing-case-insensitive', planHash, approvedBy: 'human@example.test', interfaces,
  });
  assert.deepEqual(erased, ['cus_case-insensitive']);
  assert.equal(result.certificate.manifest.length, 1);
  assert.equal(result.certificate.manifest[0].system, 'BiLlInG');
});

test('keeps certificate, case, and execution run terminal state consistent on SQLite finalization failure', async () => {
  const { planHash } = approvedCase('finalization-sqlite-error', [
    { system: 'billing', record_type: 'customer', record_id: 'cus_finalization' },
  ]);
  db.exec(`CREATE TRIGGER fail_execution_finalization
    BEFORE UPDATE OF status ON execution_runs
    WHEN NEW.status = 'completed'
    BEGIN SELECT RAISE(ABORT, 'simulated finalization sqlite error'); END;`);
  try {
    await assert.rejects(oublietteExecuteErasure({
      caseId: 'finalization-sqlite-error', planHash, approvedBy: 'human@example.test',
      interfaces: { billing: async () => ({ deleted: 1 }) },
    }), /simulated finalization sqlite error/);
  } finally {
    db.exec('DROP TRIGGER fail_execution_finalization');
  }

  assert.equal(getCase('finalization-sqlite-error').status, 'failed');
  assert.equal(getCase('finalization-sqlite-error').certificate, undefined);
  assert.equal(db.prepare('SELECT status FROM execution_runs WHERE case_id = ? AND plan_hash = ?')
    .get('finalization-sqlite-error', planHash).status, 'failed');
});

test('passes each destructive adapter its required execution envelope', async () => {
  const { body, planHash } = approvedCase('adapter-envelope', [
    { system: 'postgres', record_type: 'account', record_id: 12, disposition: 'erase' },
    { system: 'minio', record_type: 'object', record_id: 'uploads/envelope', locator: 'uploads/envelope', disposition: 'erase' },
    { system: 'billing', record_type: 'customer', record_id: 'cus_envelope', disposition: 'erase' },
  ]);
  const seen = {};
  const result = await oublietteExecuteErasure({
    caseId: 'adapter-envelope', planHash, approvedBy: 'human@example.test',
    interfaces: {
      database: async (input) => {
        seen.database = input;
        return { counts: { accounts: 1 } };
      },
      minio: async (input) => {
        seen.minio = input;
        return { results: [{ key: 'uploads/envelope', status: 'deleted' }] };
      },
      billing: async (input) => {
        seen.billing = input;
        return { ok: true, erased: ['cus_envelope'] };
      },
      postgresTransaction: async () => ({ manifest: [] }),
      billingErase: async () => {},
    },
  });
  assert.deepEqual(seen.database.actions, body.actions);
  assert.equal(seen.database.grouped_actions.length, 1);
  assert.deepEqual(seen.minio.plan, body);
  assert.equal(seen.minio.planHash, planHash);
  assert.equal(seen.minio.approval.plan_hash, planHash);
  assert.equal(seen.minio.postgresPhase.success, true);
  assert.equal(typeof seen.billing.postgresTransaction, 'function');
  assert.equal(typeof seen.billing.billingErase, 'function');
  assert.equal(seen.billing.caseId, 'adapter-envelope');
  assert.equal(result.certificate.manifest.length, 3);
});

test('rejects explicit adapter failure results without certifying the plan', async () => {
  const { planHash } = approvedCase('adapter-failure-result', [
    { system: 'postgres', record_type: 'account', record_id: 10, disposition: 'erase' },
    { system: 'minio', record_type: 'object', record_id: 'uploads/failure', disposition: 'erase' },
  ]);
  const calls = [];
  await assert.rejects(oublietteExecuteErasure({
    caseId: 'adapter-failure-result', planHash, approvedBy: 'human@example.test', interfaces: {
      database: async () => ({ deleted: 1 }),
      minio: async () => { calls.push('minio'); return { success: false, counts: { requested: 1, deleted: 0, failed: 1 } }; },
      billing: async () => { calls.push('billing'); return { deleted: 0 }; },
    },
  }), /minio execution did not confirm/);
  assert.deepEqual(calls, ['minio']);
  assert.equal(getCase('adapter-failure-result').status, 'failed');
  assert.equal(getCase('adapter-failure-result').certificate, undefined);
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

test('does not treat an untracked failed case as a retryable execution', async () => {
  const { planHash } = approvedCase('untracked-failure', [
    { system: 'billing', record_type: 'customer', record_id: 'cus_untracked', disposition: 'erase' },
  ]);
  db.prepare("UPDATE cases SET status = 'failed' WHERE id = ?").run('untracked-failure');
  await assert.rejects(
    oublietteExecuteErasure({ caseId: 'untracked-failure', planHash, approvedBy: 'human@example.test', interfaces: { billing: async () => ({ deleted: 1 }) } }),
    /case changed before execution/,
  );
});

test('rejects a second execution while the first claim is active', async () => {
  const { planHash } = approvedCase('exclusive-claim', [
    { system: 'billing', record_type: 'customer', record_id: 'cus_exclusive', disposition: 'erase' },
  ]);
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  let release;
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const interfaces = { billing: async () => {
    entered();
    await releasePromise;
    return { deleted: 1 };
  } };
  const first = oublietteExecuteErasure({ caseId: 'exclusive-claim', planHash, approvedBy: 'human@example.test', interfaces });
  await enteredPromise;
  await assert.rejects(
    oublietteExecuteErasure({ caseId: 'exclusive-claim', planHash, approvedBy: 'human@example.test', interfaces }),
    /already executing/,
  );
  release();
  await first;
});

test('rejects a new approval while an execution run is active', async () => {
  const { planHash } = approvedCase('approval-concurrency', [
    { system: 'billing', record_type: 'customer', record_id: 'cus_approval-concurrency', disposition: 'erase' },
  ]);
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  let release;
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const first = oublietteExecuteErasure({
    caseId: 'approval-concurrency', planHash, approvedBy: 'human@example.test',
    interfaces: { billing: async () => {
      entered();
      await releasePromise;
      return { deleted: 1 };
    } },
  });
  await enteredPromise;

  assert.throws(
    () => recordApproval('approval-concurrency', planHash, 'new-human@example.test', 're-reviewed'),
    /case is executing and cannot be modified/,
  );
  assert.equal(getCase('approval-concurrency').approvals.length, 1);

  release();
  const result = await first;
  assert.equal(result.certificate.approved_by, 'human@example.test');
});

test('binds the certificate to the claimed approval record, not a later approval row', async () => {
  const { planHash } = approvedCase('approval-binding', [
    { system: 'billing', record_type: 'customer', record_id: 'cus_approval-binding', disposition: 'erase' },
  ]);
  const originalApproval = getCase('approval-binding').approvals.at(-1);
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  let release;
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const first = oublietteExecuteErasure({
    caseId: 'approval-binding', planHash, approvedBy: 'human@example.test',
    interfaces: { billing: async () => {
      entered();
      await releasePromise;
      return { deleted: 1 };
    } },
  });
  await enteredPromise;

  const run = db.prepare('SELECT approval_id FROM execution_runs WHERE case_id = ? AND plan_hash = ?')
    .get('approval-binding', planHash);
  assert.equal(run.approval_id, originalApproval.id);
  db.prepare(`INSERT INTO approvals
    (case_id, plan_hash, case_revision, approved_by, reason, approved_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    'approval-binding', planHash, originalApproval.case_revision,
    'new-human@example.test', 'concurrent approval', now(),
  );

  release();
  const result = await first;
  assert.equal(result.certificate.approved_by, 'human@example.test');
  assert.equal(getCase('approval-binding').certificate.approved_by, 'human@example.test');
  assert.equal(db.prepare('SELECT approval_id FROM execution_runs WHERE case_id = ? AND plan_hash = ?')
    .get('approval-binding', planHash).approval_id, originalApproval.id);
});

test('resumes committed phases when a downstream phase fails', async () => {
  const { planHash } = approvedCase('resume-after-failure', [
    { system: 'postgres', record_type: 'account', record_id: 11, disposition: 'erase' },
    { system: 'minio', record_type: 'object', record_id: 'uploads/retry', disposition: 'erase' },
  ]);
  await assert.rejects(oublietteExecuteErasure({
    caseId: 'resume-after-failure', planHash, approvedBy: 'human@example.test', interfaces: {
      database: async () => ({ deleted: 1 }),
      minio: async () => { throw new Error('downstream unavailable'); },
    },
  }), /downstream unavailable/);

  const result = await oublietteExecuteErasure({
    caseId: 'resume-after-failure', planHash, approvedBy: 'human@example.test', interfaces: {
      database: async () => { throw new Error('database must not be repeated'); },
      minio: async () => ({ deleted: 1 }),
    },
  });
  assert.equal(result.systems.database.resumed, true);
  assert.equal(result.systems.minio.ok, true);
  assert.deepEqual(result.certificate.manifest.map((item) => item.system), ['postgres', 'minio']);
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
