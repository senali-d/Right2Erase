import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PHASES, type Phase, phaseForTool, phaseIndex } from './phases';

/**
 * Tracks one agent invocation so the UI can show live progress.
 *
 * Everything durable about a case already lives in Oubliette's SQLite store and
 * is readable via case_get. Only two things do not: which phase the agent is in
 * right now, and the sandbox rehearsal transcript, which prepare() returns and
 * then discards. This module holds exactly those.
 *
 * Runs are mirrored to disk so a page refresh - or a dev-server restart
 * mid-demo - does not lose the rehearsal transcript, which is the one piece of
 * evidence that cannot be recomputed after the fact. The mirror is written on
 * phase transitions and on completion only: a seeded subject produces 500+ tool
 * calls, and writing the file on each one would be far more I/O than the demo
 * needs.
 */

export type RunKind = 'prepare' | 'execute';
export type RunStatus = 'running' | 'done' | 'failed';

export type ToolEvent = { tool: string; ok: boolean; ms: number; at: string };

export type PhaseState = { started_at?: string; completed_at?: string; tool_calls: number };

export type RehearsalAttempt = {
  order: 'as_planned' | 'canonical_leaf_to_root';
  ok: boolean;
  /** Present on a successful attempt. */
  steps?: number;
  /** Present on a failed attempt - the two shapes use different key names. */
  completed_steps?: number;
  failed_action?: { record_type: string; record_id: string | number } | null;
  error?: string;
};

export type RehearsalEntry = {
  account_id: number;
  snapshot_id: string;
  attempts: RehearsalAttempt[];
};

/**
 * Identifies the paused tool call a human is being asked to authorise.
 *
 * The harness pauses the turn on the destructive tool and keeps the session
 * alive; approving is resuming that same turn, not starting a new one. Both
 * ids are needed to address it, and they are the only things the UI needs to
 * hold between the pause and the click.
 */
export type ApprovalRequest = {
  thread_id: string;
  tool_call_ids: string[];
};

export type Run = {
  run_id: string;
  kind: RunKind;
  subject_email?: string;
  case_id?: string;
  status: RunStatus;
  phase: Phase;
  phases: Record<Phase, PhaseState>;
  recent: ToolEvent[];
  tool_calls: number;
  rehearsal?: RehearsalEntry[];
  error?: string;
  started_at: string;
  finished_at?: string;
  /** Set when the agent runs on the TrueForge harness rather than in-process. */
  session_id?: string;
  /** Present only while a turn is paused at the approval gate. */
  approval_request?: ApprovalRequest;
};

const RECENT_LIMIT = 50;

// next dev re-evaluates modules on hot reload; a module-level Map would be
// replaced mid-run and orphan the run the browser is polling for.
const runs: Map<string, Run> = ((globalThis as Record<string, unknown>).__oublietteRuns ??= new Map()) as Map<string, Run>;

function runsDir(): string {
  // The web app's cwd is web/, one level below the repo root where the MCP
  // servers put .oubliette.
  return process.env.OUBLIETTE_RUNS_DIR || path.resolve(process.cwd(), '..', '.oubliette', 'runs');
}

function flush(run: Run): void {
  try {
    const dir = runsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${run.run_id}.json`), JSON.stringify(run, null, 2));
  } catch {
    // The mirror is a convenience. Losing it must never fail an erasure run.
  }
}

function emptyPhases(): Record<Phase, PhaseState> {
  return Object.fromEntries(PHASES.map((p) => [p, { tool_calls: 0 }])) as Record<Phase, PhaseState>;
}

export function createRun(init: { kind: RunKind; subject_email?: string; case_id?: string }): Run {
  const now = new Date().toISOString();
  const run: Run = {
    run_id: randomUUID(),
    kind: init.kind,
    subject_email: init.subject_email,
    case_id: init.case_id,
    status: 'running',
    // An execute run starts at the approval gate; a prepare run starts at discovery.
    phase: init.kind === 'execute' ? 'approval' : 'discovery',
    phases: emptyPhases(),
    recent: [],
    tool_calls: 0,
    started_at: now,
  };
  run.phases[run.phase].started_at = now;
  runs.set(run.run_id, run);
  flush(run);
  return run;
}

export function getRun(runId: string): Run | null {
  const live = runs.get(runId);
  if (live) return live;
  // Fall back to the mirror so a restarted dev server can still render a
  // finished run's rehearsal transcript.
  try {
    const raw = fs.readFileSync(path.join(runsDir(), `${runId}.json`), 'utf8');
    const parsed = JSON.parse(raw) as Run;
    // A run that was mid-flight when the process died can never resume; the
    // agent it belonged to is gone. Report it as failed rather than leaving the
    // UI polling a run that will never advance.
    if (parsed.status === 'running') {
      parsed.status = 'failed';
      parsed.error = 'run was interrupted before it completed';
    }
    return parsed;
  } catch {
    return null;
  }
}

export function attachCaseId(runId: string, caseId: string): void {
  const run = runs.get(runId);
  if (!run || run.case_id === caseId) return;
  run.case_id = caseId;
  flush(run);
}

export function setSessionId(runId: string, sessionId: string): void {
  const run = runs.get(runId);
  if (!run || run.session_id === sessionId) return;
  run.session_id = sessionId;
  flush(run);
}

export function setApprovalRequest(runId: string, request: ApprovalRequest): void {
  const run = runs.get(runId);
  if (!run) return;
  run.approval_request = request;
  flush(run);
}

/**
 * Store a rehearsal transcript as it happens.
 *
 * On the harness this is the only place the transcript exists - it is a tool
 * result on the event stream, not the return value of a function the web layer
 * called - so it is captured here rather than reconstructed at the end.
 */
export function recordRehearsal(runId: string, entry: RehearsalEntry): void {
  const run = runs.get(runId);
  if (!run) return;
  run.rehearsal = [...(run.rehearsal ?? []), entry];
  flush(run);
}

export function recordToolCall(runId: string, event: { tool: string; ok: boolean; ms: number }): void {
  const run = runs.get(runId);
  if (!run) return;

  const at = new Date().toISOString();
  const next = phaseForTool(event.tool);

  // Phases only ever move forward. plan_create runs before the sandbox but the
  // agent also calls read-only db_ tools during rehearsal, and a stray
  // discovery-classified call must not drag the rail back to Discovery.
  if (phaseIndex(next) > phaseIndex(run.phase)) {
    run.phases[run.phase].completed_at = at;
    run.phase = next;
    run.phases[next].started_at ??= at;
    flush(run);
  }

  run.phases[run.phase].tool_calls += 1;
  run.tool_calls += 1;
  run.recent.push({ tool: event.tool, ok: event.ok, ms: event.ms, at });
  if (run.recent.length > RECENT_LIMIT) run.recent.splice(0, run.recent.length - RECENT_LIMIT);
}

export function finishRun(
  runId: string,
  outcome: { rehearsal?: RehearsalEntry[]; case_id?: string; error?: string },
): void {
  const run = runs.get(runId);
  if (!run) return;
  const at = new Date().toISOString();
  run.phases[run.phase].completed_at ??= at;
  if (outcome.case_id) run.case_id = outcome.case_id;
  if (outcome.rehearsal) run.rehearsal = outcome.rehearsal;
  if (outcome.error) {
    run.status = 'failed';
    run.error = outcome.error;
  } else {
    run.status = 'done';
    // A finished execute run has produced a certificate; show the rail complete.
    if (run.kind === 'execute') {
      run.phase = 'certificate';
      run.phases.certificate.started_at ??= at;
      run.phases.certificate.completed_at ??= at;
    }
  }
  run.finished_at = at;
  flush(run);
}
