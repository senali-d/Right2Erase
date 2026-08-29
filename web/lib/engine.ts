import * as deterministic from './agent-runs.ts';
import * as agentic from './trueforge-runs.ts';
import { getRun, type Run } from './run-store.ts';

/**
 * Which engine investigates a case.
 *
 * Two exist on purpose. `agentic` is the product: a model on the TrueForge
 * harness that decides what to search and what to do. `deterministic` is the
 * original fixed script, kept because it is the oracle - when a run comes back
 * wrong, it answers "is this the model or the plumbing?" in one command - and
 * because it is a one-flag fallback if the model misbehaves during a demo.
 *
 * Both drive the same MCP servers, so the safety guarantees are identical
 * either way: they live in the adapters, not in whichever engine is calling.
 */
export type EngineName = 'agentic' | 'deterministic';

export const DEFAULT_ENGINE: EngineName =
  process.env.OUBLIETTE_ENGINE === 'deterministic' ? 'deterministic' : 'agentic';

export function engineFrom(value: string | null | undefined): EngineName {
  return value === 'deterministic' || value === 'agentic' ? value : DEFAULT_ENGINE;
}

export function startPrepareRun(subjectEmail: string, engine: EngineName): Run {
  return engine === 'deterministic'
    ? deterministic.startPrepareRun(subjectEmail)
    : agentic.startPrepareRun(subjectEmail);
}

/**
 * Refuse a paused run that does not match what is being approved.
 *
 * Separate from approveRun so the caller can check *before* recording the
 * approval. An approval is an audit record of a person consenting to one
 * specific plan; writing one for a plan that is not the one about to run is
 * worse than refusing outright.
 */
export function assertApprovable(paused: Run, args: { case_id: string; plan_hash: string }): void {
  // The run id arrives from the client, so it is not trusted to identify which
  // case is being approved. Resuming a paused run from a different case would
  // validate this case's plan and then execute that one's erasure - the
  // approval a human gave and the deletion that happens have to be the same
  // case.
  if (paused.case_id !== args.case_id) {
    throw new Error('that paused run belongs to a different case');
  }
  // The turn may have been waiting while the case moved on and a newer plan was
  // built. Approving would then consent to the plan on screen while resuming a
  // call carrying the older one. Oubliette refuses that at execution time, but
  // only after the operator has been told their approval succeeded.
  const pendingHash = paused.approval_request?.plan_hash;
  if (pendingHash && pendingHash !== args.plan_hash) {
    throw new Error(
      'the paused run is executing an older plan than the one being approved; re-open the case and review the current plan',
    );
  }
}

/**
 * Approve a plan.
 *
 * The two engines reach the same destructive tool by different routes. The
 * agentic one is paused mid-turn and resumes when the pending call is allowed;
 * the deterministic one has already returned, so approving starts the
 * execution step. The UI does not need to know which - it passes the run it is
 * looking at, and the engine that produced it decides.
 */
export function approveRun(
  paused: Run | null,
  args: { case_id: string; plan_hash: string; approved_by: string },
): Run {
  if (paused?.session_id && paused.approval_request) {
    assertApprovable(paused, args);
    return agentic.resolveApproval(paused, { allow: true, approvedBy: args.approved_by });
  }
  return deterministic.startExecuteRun(args);
}

/**
 * The run behind an id, but only if it is paused at the approval gate for this
 * case. The id comes from the client, so the case it belongs to is checked
 * here rather than assumed.
 */
export function pausedRunFor(runId: string | null | undefined, caseId: string): Run | null {
  if (!runId) return null;
  const run = getRun(runId);
  if (!run?.approval_request || run.case_id !== caseId) return null;
  return run;
}
