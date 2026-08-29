import { Panel } from '@/components/ui/Panel';
import { Badge } from '@/components/ui/Badge';
import type { RehearsalAttempt, RehearsalEntry } from '@/lib/run-store';

const ORDER_LABEL: Record<string, string> = {
  as_planned: 'as planned',
  canonical_leaf_to_root: 'canonical leaf-to-root',
};

/**
 * Renders the rehearsal exactly as it happened, including the failure.
 *
 * The agent records an account's orders before their order items, so the first
 * attempt hits a foreign-key violation against a real FK-enforcing copy of the
 * data, and the retry in canonical order succeeds. Collapsing that to a single
 * green check would hide the only evidence that the plan was actually tested
 * rather than merely assembled.
 */
function Attempt({
  attempt,
  index,
}: {
  attempt: RehearsalAttempt;
  index: number;
}) {
  // The two shapes carry different keys and mean different things: steps is a
  // completed rehearsal, completed_steps is how far it got before failing.
  const steps = attempt.ok
    ? typeof attempt.steps === 'number'
      ? `${attempt.steps.toLocaleString()} steps`
      : null
    : typeof attempt.completed_steps === 'number'
      ? `failed after ${attempt.completed_steps.toLocaleString()} steps`
      : null;
  return (
    <li
      className={`rounded border px-3.5 py-3 ${attempt.ok ? 'border-verify/30 bg-verify-dim/40' : 'border-danger/30 bg-danger-dim/40'}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={attempt.ok ? 'text-verify' : 'text-danger'}>
          {attempt.ok ? '✓' : '✗'}
        </span>
        <span className="text-ink">Attempt {index + 1}</span>
        <span className="text-ink-faint">
          {ORDER_LABEL[attempt.order] ?? attempt.order}
        </span>
        <span className="ml-auto tabular-nums text-ink-dim">{steps}</span>
      </div>
      {!attempt.ok ? (
        <div className="mt-2 space-y-1">
          <p className="text-danger">{attempt.error}</p>
          {attempt.failed_action ? (
            <p className="text-ink-faint">
              failed on {attempt.failed_action.record_type} #
              {String(attempt.failed_action.record_id)}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function SandboxPanel({
  rehearsal,
  running,
}: {
  rehearsal?: RehearsalEntry[];
  running: boolean;
}) {
  if (!rehearsal?.length) {
    return (
      <Panel title="Sandbox rehearsal">
        <p className="text-ink-dim">
          {running
            ? 'Exporting a throwaway snapshot and rehearsing the deletion against it…'
            : 'No rehearsal transcript for this case in the current session. The stored plan is itself evidence that rehearsal passed - prepare() refuses to return a plan that never rehearsed cleanly.'}
        </p>
      </Panel>
    );
  }

  const passed = rehearsal.every((entry) => entry.attempts.at(-1)?.ok);
  const retried = rehearsal.some((entry) => entry.attempts.length > 1);

  return (
    <Panel
      tone={passed ? 'verify' : 'danger'}
      title="Sandbox rehearsal"
      aside={
        <Badge tone={passed ? 'verify' : 'danger'}>
          {passed ? 'passed' : 'failed'}
        </Badge>
      }
    >
      <div className="space-y-4">
        {rehearsal.map((entry) => (
          <div key={entry.snapshot_id}>
            <div className="mb-2 text-[11px] text-ink-faint">
              {entry.account_id != null ? `account ${entry.account_id} · ` : ''}
              snapshot {entry.snapshot_id.slice(0, 8)}… · deleted after
              rehearsal
            </div>
            <ul className="space-y-2">
              {entry.attempts.map((attempt, index) => (
                <Attempt key={attempt.order} attempt={attempt} index={index} />
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
        {retried
          ? 'The first attempt used the plan’s own action order and hit a foreign-key violation; the agent retried in canonical leaf-to-root order and it passed. '
          : ''}
        Every attempt ran inside a transaction that is always rolled back,
        against a throwaway SQLite copy that enforces the same foreign keys as
        production. The snapshot is a full copy of the subject’s data and is
        deleted as soon as the rehearsal finishes.
      </p>
    </Panel>
  );
}
