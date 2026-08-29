import { TrueForge, type TrueForgeApi, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import {
  attachCaseId, createRun, finishRun, recordRehearsal, recordToolCall,
  setApprovalRequest, setSessionId, type ApprovalRequest, type RehearsalAttempt, type Run,
} from './run-store.ts';

/**
 * Drives the erasure agent on the TrueForge harness.
 *
 * The agent loop - model calls, tool routing, approvals, session state - lives
 * in TrueForge. This module only translates its event stream into the run
 * records the control center already renders, so every panel keeps working
 * against a reasoning agent exactly as it did against the fixed script.
 *
 * The approval gate is the harness's own: the agent is configured to require
 * approval for oubliette_execute_erasure, so the turn pauses on
 * `tool.approval_required` and stays paused until a human sends back a
 * `user.tool_approval`. Nothing in this file can execute an erasure by itself,
 * and Oubliette still re-validates the plan hash, the approver, and the case
 * revision before any adapter runs.
 */

const AGENT_NAME = process.env.TRUEFORGE_AGENT || 'oubliette-erasure';

function client() {
  return new TrueForge({
    baseUrl: process.env.TRUEFORGE_BASE_URL || 'http://localhost:8790',
    // One turn covers the whole investigation and can run for many minutes.
    timeoutInSeconds: 1800,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tool results arrive as MCP content blocks; the payload is JSON in a text block. */
function parseContent(content: unknown): unknown {
  if (typeof content === 'string') {
    try { return JSON.parse(content); } catch { return content; }
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      const text = (block as { text?: string })?.text;
      if (typeof text !== 'string') continue;
      try { return JSON.parse(text); } catch { /* try the next block */ }
    }
  }
  return content;
}

type ToolResponseEvent = { toolCallId?: string; isError?: boolean; content?: unknown };

/**
 * The plan hash the paused execution call is about to act on.
 *
 * The approval event references its calls by id; the arguments live on the
 * `model.message` that announced them, which is why the accumulated events are
 * needed to find it. Reading the hash from the call itself - rather than
 * trusting whatever the browser later submits - is what makes it possible to
 * tell that the operator is approving a different plan than the one waiting to
 * run.
 */
function pendingPlanHash(
  events: Map<string, TrueForgeApi.TurnStreamingEvent>,
  pending: TrueForgeApi.ToolApprovalRequiredEvent,
): string | undefined {
  for (const ref of pending.toolCalls) {
    const source = events.get(ref.sourceEventId);
    if (source?.type !== 'model.message') continue;
    const call = (source as TrueForgeApi.ModelMessageEvent).toolCalls?.find((entry) => entry.id === ref.id);
    if (call?.toolInfo?.name !== 'oubliette_execute_erasure') continue;
    try {
      const args = JSON.parse(call.function?.arguments || '{}') as { plan_hash?: unknown };
      if (typeof args.plan_hash === 'string') return args.plan_hash;
    } catch {
      // Unparseable arguments leave the hash unknown; the caller treats that
      // as "cannot verify" rather than "verified".
    }
  }
  return undefined;
}

/**
 * Consume one turn's event stream into a run record.
 *
 * Tool calls are announced on `model.message`, but only after their deltas are
 * merged - a bare event carries no `toolCalls` - which is why events are
 * accumulated by id here rather than read directly. Progress is counted from
 * `tool.response`: a response means the tool actually ran, which is what the
 * phase rail describes.
 */
async function consume(
  runId: string,
  stream: AsyncIterable<{ data: TrueForgeApi.TurnStreamingEvent }>,
): Promise<{ failure?: string }> {
  const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
  const toolNames = new Map<string, string>();
  const startedAt = new Map<string, number>();
  let failure: string | undefined;

  /**
   * Learn the name of each tool call the message announces.
   *
   * Called after every merge as well as on the bare event, because a streamed
   * call arrives in pieces: the `model.message` that opens it carries no
   * `toolCalls` at all, and the name only exists once its deltas have been
   * merged in. Reading the event once, when it first appears, leaves every
   * call unnamed - which loses phase tracking, the case id, and the rehearsal
   * transcript on any normal streamed run. Recording is idempotent, so
   * re-harvesting the same message as it fills in is harmless, and the start
   * time is kept from the first sighting rather than the last.
   */
  const harvestToolCalls = (message: TrueForgeApi.ModelMessageEvent) => {
    for (const call of message.toolCalls ?? []) {
      const name = call.toolInfo?.name;
      if (!name || toolNames.has(call.id)) continue;
      toolNames.set(call.id, name);
      startedAt.set(call.id, Date.now());
    }
  };

  for await (const { data: event } of stream) {
    if (isEventDelta(event)) {
      const base = events.get(event.id);
      if (!base) continue;
      mergeEventDelta(base, event);
      if (base.type === 'model.message') harvestToolCalls(base as TrueForgeApi.ModelMessageEvent);
      continue;
    }
    events.set(event.id, event);

    if (event.type === 'model.message') harvestToolCalls(event as TrueForgeApi.ModelMessageEvent);

    if (event.type === 'tool.response') {
      const response = event as unknown as ToolResponseEvent;
      const callId = response.toolCallId ?? '';
      const tool = toolNames.get(callId) ?? 'tool';
      const began = startedAt.get(callId);
      recordToolCall(runId, { tool, ok: response.isError !== true, ms: began ? Date.now() - began : 0 });

      if (response.isError === true) continue;

      // The case id is knowable only from case_create's result, and the UI
      // deep-links on it as soon as it exists.
      if (tool === 'case_create') {
        const created = parseContent(response.content) as { id?: string } | null;
        if (created?.id) attachCaseId(runId, created.id);
      }

      // The rehearsal transcript exists only here, as a tool result on the
      // stream - there is no function return to read it from.
      if (tool === 'db_rehearse_deletion_plan') {
        const outcome = parseContent(response.content) as { attempts?: RehearsalAttempt[] } | null;
        if (outcome?.attempts) {
          // The tool result does not name the account, so the entry is
          // identified by the call that produced it.
          recordRehearsal(runId, { snapshot_id: callId, attempts: outcome.attempts });
        }
      }
    }

    if (event.type === 'tool.approval_required') {
      // The turn is now paused. The run carries the pending call so the UI can
      // resume it when a human decides; that record is the signal, so there is
      // nothing to return to the caller.
      const pending = event as TrueForgeApi.ToolApprovalRequiredEvent;
      setApprovalRequest(runId, {
        thread_id: pending.threadId,
        tool_call_ids: pending.toolCalls.map((ref) => ref.id),
        plan_hash: pendingPlanHash(events, pending),
      });
    }

    // A turn can end in error - an exhausted model quota, a provider outage -
    // and it says so here rather than by throwing. Without reading this the
    // run is marked done having achieved nothing, and the UI shows a phase
    // that never advances: a failure indistinguishable from a slow success,
    // which is the worst way to present one.
    if (event.type === 'turn.done') {
      const state = (event as TrueForgeApi.TurnDoneEvent).state as
        { status?: string; message?: string } | undefined;
      if (state?.status && state.status !== 'done') {
        failure = state.message || `the agent turn ended with status "${state.status}"`;
      }
    }
  }

  return { failure };
}

export function startPrepareRun(subjectEmail: string): Run {
  const run = createRun({ kind: 'prepare', subject_email: subjectEmail });

  void (async () => {
    try {
      const tf = client();
      const { data: session } = await tf.sessions.create({ agent: { name: AGENT_NAME } });
      setSessionId(run.run_id, session.id);

      const stream = await tf.sessions.createTurnStream(session.id, {
        input: [{ type: 'user.message', content: `Handle a right-to-erasure request for ${subjectEmail}.` }],
      });
      const { failure } = await consume(run.run_id, stream.withMetadata());
      finishRun(run.run_id, failure ? { error: failure } : {});
    } catch (error) {
      finishRun(run.run_id, { error: errorMessage(error) });
    }
  })();

  return run;
}

/**
 * Resume the turn the harness paused at the approval gate.
 *
 * Approving is resuming: the pending call is allowed and the agent continues
 * from exactly where it stopped, inside the same session, with the plan it
 * already built. Denying resolves the same call the other way and the agent
 * carries on without executing.
 */
export function resolveApproval(
  paused: Run,
  request: ApprovalRequest,
  decision: { allow: boolean; approvedBy: string; reason?: string },
): Run {
  const run = createRun({ kind: 'execute', case_id: paused.case_id });

  void (async () => {
    try {
      if (!paused.session_id) throw new Error('that run is not paused at an approval gate');
      setSessionId(run.run_id, paused.session_id);

      // The request is passed in rather than read off the run: it has already
      // been claimed, so the run no longer carries it.
      const input: TrueForgeApi.UserToolApprovalEvent[] = request.tool_call_ids.map((toolCallId) => ({
        type: 'user.tool_approval',
        threadId: request.thread_id,
        toolCallId,
        approval: decision.allow
          ? { status: 'allow' }
          : { status: 'deny', reason: decision.reason || `denied by ${decision.approvedBy}` },
      }));

      const stream = await client().sessions.createTurnStream(paused.session_id, { input });
      const { failure } = await consume(run.run_id, stream.withMetadata());
      finishRun(run.run_id, failure ? { error: failure } : { case_id: paused.case_id });
    } catch (error) {
      finishRun(run.run_id, { error: errorMessage(error) });
    }
  })();

  return run;
}
