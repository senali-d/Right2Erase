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
const { pausedRunFor } = await import('./engine.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function pausedRun(caseId: string) {
  const run = createRun({ kind: 'prepare', subject_email: 'subject@example.com', case_id: caseId });
  setSessionId(run.run_id, `session-for-${caseId}`);
  setApprovalRequest(run.run_id, { thread_id: 'main', tool_call_ids: ['call-1'] });
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

test('an unknown or absent run id is not returned', () => {
  assert.equal(pausedRunFor('no-such-run', 'case-a'), null);
  assert.equal(pausedRunFor(null, 'case-a'), null);
  assert.equal(pausedRunFor(undefined, 'case-a'), null);
});
