import { createAgent } from '../../agent/create-agent.js';
import { attachCaseId, createRun, finishRun, recordToolCall, type Run } from './run-store.ts';

/**
 * Runs the TrueForge agent on behalf of the UI.
 *
 * Both entry points return as soon as the run is registered and let the agent
 * finish in the background, because prepare() makes hundreds of MCP round trips
 * for a real subject and an HTTP request that waited for all of them would time
 * out long before the interesting part. The browser polls the run instead.
 *
 * The UI never performs deletion itself. executeCase() hands control to
 * agent.executeApproved(), which calls plan_approve and then
 * oubliette_execute_erasure; Oubliette independently re-validates the canonical
 * plan hash, the approving identity, and the case revision before any adapter
 * runs, so nothing here can widen what actually gets deleted.
 */

type ToolEvent = { tool: string; ok: boolean; ms: number; result?: unknown };

type AgentHandle = {
  prepare(request: { subject_email: string; subject_name?: string }): Promise<{
    case_id: string;
    rehearsal?: unknown[];
  }>;
  executeApproved(request: { case_id: string; plan_hash: string; approved_by: string }): Promise<unknown>;
  close(): Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * prepare() reports each rehearsal's snapshot_path alongside its opaque
 * snapshot_id. That path names a file that briefly held a full copy of the
 * subject's personal data, and the whole snapshot design exists to keep those
 * files addressable only by an id the server itself issued - so the path has no
 * business being mirrored to disk or handed to a browser. Keep the id, which is
 * all the UI displays.
 */
function stripSnapshotPaths(rehearsal: unknown): Run['rehearsal'] {
  if (!Array.isArray(rehearsal)) return undefined;
  return rehearsal.map((entry) => {
    const { snapshot_path: _dropped, ...rest } = entry as Record<string, unknown>;
    return rest;
  }) as Run['rehearsal'];
}

export function startPrepareRun(subjectEmail: string): Run {
  const run = createRun({ kind: 'prepare', subject_email: subjectEmail });

  const observe = (event: ToolEvent) => {
    recordToolCall(run.run_id, event);
    // case_create is the agent's second call, so claiming the id here lets the
    // browser deep-link into the live case immediately rather than waiting out
    // the whole of discovery on a spinner.
    if (event.tool === 'case_create' && event.ok) {
      const id = (event.result as { id?: string } | undefined)?.id;
      if (id) attachCaseId(run.run_id, id);
    }
  };

  void (async () => {
    let agent: AgentHandle | undefined;
    try {
      agent = (await createAgent({ onToolCall: observe })) as AgentHandle;
      const prepared = await agent.prepare({ subject_email: subjectEmail });
      finishRun(run.run_id, {
        case_id: prepared.case_id,
        rehearsal: stripSnapshotPaths(prepared.rehearsal),
      });
    } catch (error) {
      finishRun(run.run_id, { error: errorMessage(error) });
    } finally {
      await agent?.close().catch(() => {});
    }
  })();

  return run;
}

export function startExecuteRun(args: { case_id: string; plan_hash: string; approved_by: string }): Run {
  const run = createRun({ kind: 'execute', case_id: args.case_id });

  void (async () => {
    let agent: AgentHandle | undefined;
    try {
      agent = (await createAgent({
        // The human clicked Approve in the UI; that click is the approval this
        // gate represents. Oubliette still re-checks the hash, the approver's
        // identity, and the case revision server-side before executing.
        approval: async () => true,
        onToolCall: (event: ToolEvent) => recordToolCall(run.run_id, event),
      })) as AgentHandle;
      await agent.executeApproved(args);
      finishRun(run.run_id, { case_id: args.case_id });
    } catch (error) {
      finishRun(run.run_id, { error: errorMessage(error) });
    } finally {
      await agent?.close().catch(() => {});
    }
  })();

  return run;
}
