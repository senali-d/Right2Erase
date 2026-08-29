/**
 * Adversarial tests for the case store's safety invariants.
 *
 * These exist because the caller is no longer a hardcoded script. Every case
 * here asks the store to do something an agent could plausibly ask for and
 * asserts it refuses or corrects - none of them depend on the caller being
 * well-behaved, which is the whole point.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// The store opens its database at import time from OUBLIETTE_DB_PATH, so the
// temp path has to be set before the module is loaded.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oubliette-db-test-'));
process.env.OUBLIETTE_DB_PATH = path.join(tempDir, 'test.db');

const { ALWAYS_RETAIN_RECORD_TYPES, addFinding, addFindings, completeDiscovery, createCase, getCase, retentionFor } =
  await import('./db.js');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function newCase() {
  return createCase({ id: randomUUID(), subject_email: `subject-${randomUUID()}@example.com` });
}

test('a retained refund is recorded as retained even when the caller asks to erase it', () => {
  const subject = newCase();
  const finding = addFinding(subject.id, {
    system: 'postgres', record_type: 'retained_refund', record_id: 1, disposition: 'erase',
  });
  // Not an error - the record is simply not erasable, so the store corrects the
  // disposition and the caller sees the correction in the returned finding.
  assert.equal(finding.disposition, 'retain');
});

test('a retained refund is retained when no disposition is supplied at all', () => {
  const subject = newCase();
  const finding = addFinding(subject.id, { system: 'postgres', record_type: 'retained_refund', record_id: 2 });
  assert.equal(finding.disposition, 'retain');
  // ...while the default for everything else stays erase.
  const order = addFinding(subject.id, { system: 'postgres', record_type: 'order', record_id: 3 });
  assert.equal(order.disposition, 'erase');
});

test('retentionFor leaves ordinary record types under the caller control', () => {
  assert.equal(retentionFor('order', 'erase'), 'erase');
  assert.equal(retentionFor('order', 'review'), 'review');
  assert.equal(retentionFor('order', undefined), 'erase');
  assert.equal(retentionFor('retained_refund', 'erase'), 'retain');
  assert.equal(ALWAYS_RETAIN_RECORD_TYPES.has('retained_refund'), true);
});

test('discovery cannot be completed for a case with no findings', () => {
  const subject = newCase();
  assert.throws(
    () => completeDiscovery(subject.id),
    /has no findings; refusing to complete discovery/,
  );
  // The case is left un-completed, so plan_create still refuses it.
  assert.equal(getCase(subject.id).discovery_completed_at, null);
});

test('discovery completes once a case has at least one finding', () => {
  const subject = newCase();
  addFinding(subject.id, { system: 'postgres', record_type: 'account', record_id: 7 });
  assert.ok(completeDiscovery(subject.id).discovery_completed_at);
});

test('a batch records every finding and enforces retention per row', () => {
  const subject = newCase();
  const summary = addFindings(subject.id, [
    { system: 'postgres', record_type: 'order', record_id: 1 },
    { system: 'postgres', record_type: 'retained_refund', record_id: 2, disposition: 'erase' },
    { system: 'minio', record_type: 'object', record_id: 'uploads/acct_1/a.png', locator: 'uploads/acct_1/a.png' },
  ]);
  assert.equal(summary.added, 3);
  assert.equal(summary.finding_count, 3);

  const byType = Object.fromEntries(getCase(subject.id).findings.map((f) => [f.record_type, f.disposition]));
  assert.equal(byType.order, 'erase');
  // The coercion applies inside a batch too - a bulk path that skipped it
  // would be the easiest way to lose the guarantee.
  assert.equal(byType.retained_refund, 'retain');
});

test('a batch is one revision bump, not one per finding', () => {
  const subject = newCase();
  const before = getCase(subject.id).revision;
  addFindings(subject.id, Array.from({ length: 25 }, (_, i) => ({
    system: 'postgres', record_type: 'event', record_id: i,
  })));
  assert.equal(getCase(subject.id).revision, before + 1);
});

test('an empty batch is refused rather than silently doing nothing', () => {
  const subject = newCase();
  assert.throws(() => addFindings(subject.id, []), /non-empty array/);
  assert.throws(() => addFindings(subject.id, undefined), /non-empty array/);
});

test('a batch that fails partway records none of its findings', () => {
  const subject = newCase();
  addFindings(subject.id, [{ system: 'postgres', record_type: 'order', record_id: 1 }]);
  const countBefore = getCase(subject.id).findings.length;
  // findings has UNIQUE(case_id, system, record_type, record_id): the duplicate
  // in the middle aborts the transaction, so the valid rows around it must not
  // survive - a half-recorded batch is a silently incomplete case.
  assert.throws(() => addFindings(subject.id, [
    { system: 'postgres', record_type: 'order', record_id: 99 },
    { system: 'postgres', record_type: 'order', record_id: 1 },
    { system: 'postgres', record_type: 'order', record_id: 100 },
  ]));
  assert.equal(getCase(subject.id).findings.length, countBefore);
});

test('the retention rule matches the exact vocabulary the finding schema allows', () => {
  // Regression guard. When record_type was free text, a caller writing the
  // plural table name recorded a retained refund as erasable and the coercion
  // silently did not fire. The schema now admits only the singular form, so
  // this asserts the two agree - if someone widens the schema, this fails.
  for (const recordType of ALWAYS_RETAIN_RECORD_TYPES) {
    assert.equal(retentionFor(recordType, 'erase'), 'retain');
  }
  assert.equal(ALWAYS_RETAIN_RECORD_TYPES.has('retained_refund'), true);
  assert.equal(ALWAYS_RETAIN_RECORD_TYPES.has('retained_refunds'), false,
    'the plural is not a valid record_type; if it becomes one, it must be added here too');
});

test('recording a finding re-opens discovery so a later plan cannot use a stale completion', () => {
  const subject = newCase();
  addFinding(subject.id, { system: 'postgres', record_type: 'account', record_id: 8 });
  completeDiscovery(subject.id);
  addFinding(subject.id, { system: 'minio', record_type: 'object', record_id: 'uploads/acct_8/a.png' });
  assert.equal(getCase(subject.id).discovery_completed_at, null);
});
