import * as deterministic from './agent-runs';
import * as agentic from './trueforge-runs';
import { getRun, type Run } from './run-store';

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
    return agentic.resolveApproval(paused, { allow: true, approvedBy: args.approved_by });
  }
  return deterministic.startExecuteRun(args);
}

export function denyRun(run: Run, reason: string, deniedBy: string): Run {
  if (!run.session_id || !run.approval_request) {
    throw new Error('only a run paused at the approval gate can be denied');
  }
  return agentic.resolveApproval(run, { allow: false, approvedBy: deniedBy, reason });
}

/** The most recent run for a case that is paused at the approval gate, if any. */
export function pausedRunFor(runId: string | null | undefined): Run | null {
  if (!runId) return null;
  const run = getRun(runId);
  return run?.approval_request ? run : null;
}
