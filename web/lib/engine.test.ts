/**
 * The approval routing guard.
 *
 * A paused run is addressed by a run id that arrives from the browser, so it
 * cannot be trusted to say which case is being approved. Resuming a run
 * belonging to another case would validate one case's plan and then execute a
 * different case's erasure - the approval a human gave and the deletion that
 * happens have to be the same case. These tests pin that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// run-store mirrors runs to disk; keep that out of the repo during tests.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oubliette-engine-test-'));
process.env.OUBLIETTE_RUNS_DIR = tempDir;

const { createRun, setApprovalRequest, setSessionId } = await import('./run-store.ts');
const { assertApprovable, claimApproval, pausedRunFor, releaseApproval } = await import('./engine.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function pausedRun(caseId: string, planHash?: string) {
  const run = createRun({ kind: 'prepare', subject_email: 'subject@example.com', case_id: caseId });
  setSessionId(run.run_id, `session-for-${caseId}`);
  setApprovalRequest(run.run_id, { thread_id: 'main', tool_call_ids: ['call-1'], plan_hash: planHash });
  return run;
}

test('a paused run is returned for the case it belongs to', () => {
  const run = pausedRun('case-a');
  assert.equal(pausedRunFor(run.run_id, 'case-a')?.run_id, run.run_id);
});

test('a paused run from another case is not returned', () => {
  const run = pausedRun('case-a');
  // The caller asked to approve case-b while handing over case-a's run.
  assert.equal(pausedRunFor(run.run_id, 'case-b'), null);
});

test('a run that is not paused at the gate is not returned', () => {
  const run = createRun({ kind: 'prepare', subject_email: 'subject@example.com', case_id: 'case-c' });
  setSessionId(run.run_id, 'session-c');
  assert.equal(pausedRunFor(run.run_id, 'case-c'), null);
});

test('a paused run executing an older plan is refused', () => {
  // The turn sat paused while the case moved on and a newer plan was built.
  // Approving the newer plan must not resume a call carrying the older hash:
  // that records consent for one plan and executes another.
  const run = pausedRun('case-a', HASH_A);
  assert.throws(
    () => assertApprovable(run, { case_id: 'case-a', plan_hash: HASH_B }),
    /older plan than the one being approved/,
  );
});

test('a paused run executing the approved plan is allowed', () => {
  const run = pausedRun('case-a', HASH_A);
  assert.doesNotThrow(() => assertApprovable(run, { case_id: 'case-a', plan_hash: HASH_A }));
});

test('a paused run whose plan hash could not be read is not blocked on that basis', () => {
  // Unknown is not the same as mismatched. Oubliette independently refuses a
  // stale plan at execution time, so failing closed here would only turn a
  // recoverable unknown into a dead end.
  const run = pausedRun('case-a', undefined);
  assert.doesNotThrow(() => assertApprovable(run, { case_id: 'case-a', plan_hash: HASH_B }));
});

test('assertApprovable still refuses a run from another case', () => {
  const run = pausedRun('case-a', HASH_A);
  assert.throws(
    () => assertApprovable(run, { case_id: 'case-b', plan_hash: HASH_A }),
    /different case/,
  );
});

test('an approval can be claimed exactly once', () => {
  // The claim is what makes approval single-use. Without it a double click, a
  // retry, or a replayed request each submits the same destructive call again,
  // and the later resume fails after the erasure has already run.
  const run = pausedRun('case-a', HASH_A);
  const args = { case_id: 'case-a', plan_hash: HASH_A };

  const claimed = claimApproval(run, args);
  assert.deepEqual(claimed.tool_call_ids, ['call-1']);

  assert.throws(() => claimApproval(run, args), /already been submitted/);
});

test('a claimed approval is no longer offered as a paused run', () => {
  const run = pausedRun('case-a', HASH_A);
  claimApproval(run, { case_id: 'case-a', plan_hash: HASH_A });
  assert.equal(pausedRunFor(run.run_id, 'case-a'), null);
});

test('a released claim can be approved again', () => {
  // Releasing is for the path where the approval could not be recorded and no
  // execution started; the operator must be able to retry.
  const run = pausedRun('case-a', HASH_A);
  const args = { case_id: 'case-a', plan_hash: HASH_A };

  const claimed = claimApproval(run, args);
  releaseApproval(run, claimed);

  assert.equal(pausedRunFor(run.run_id, 'case-a')?.run_id, run.run_id);
  assert.doesNotThrow(() => claimApproval(run, args));
});

test('a stale or wrong-case run is refused before it can be claimed', () => {
  const stale = pausedRun('case-a', HASH_A);
  assert.throws(() => claimApproval(stale, { case_id: 'case-a', plan_hash: HASH_B }), /older plan/);
  // The failed claim must not have consumed the request.
  assert.ok(pausedRunFor(stale.run_id, 'case-a'));

  const other = pausedRun('case-a', HASH_A);
  assert.throws(() => claimApproval(other, { case_id: 'case-b', plan_hash: HASH_A }), /different case/);
  assert.ok(pausedRunFor(other.run_id, 'case-a'));
});

test('an unknown or absent run id is not returned', () => {
  assert.equal(pausedRunFor('no-such-run', 'case-a'), null);
  assert.equal(pausedRunFor(null, 'case-a'), null);
  assert.equal(pausedRunFor(undefined, 'case-a'), null);
});
