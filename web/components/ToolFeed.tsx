import type { ToolEvent } from '@/lib/run-store';

/**
 * The agent's live tool calls.
 *
 * A spinner says "wait"; this says what the agent is doing right now, in its
 * own vocabulary. Newest first so the moving edge stays in view without
 * scroll-anchoring.
 */
export function ToolFeed({
  events,
  total,
}: {
  events: ToolEvent[];
  total: number;
}) {
  if (!events.length) return null;

  return (
    <div className="rounded border border-line bg-surface">
      <header className="flex items-baseline justify-between border-b border-line px-3 py-2">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-dim">
          Tool calls
        </h2>
        <span className="text-[10px] tabular-nums text-ink-faint">
          {total.toLocaleString()}
        </span>
      </header>
      <ul className="max-h-72 overflow-y-auto px-3 py-2">
        {[...events].reverse().map((event, index) => (
          <li
            key={`${event.at}-${index}`}
            className="flex items-baseline gap-2 py-0.5 text-[11px]"
          >
            <span className={event.ok ? 'text-verify' : 'text-danger'}>
              {event.ok ? '·' : '✗'}
            </span>
            <span className="truncate text-ink-dim">{event.tool}</span>
            <span className="ml-auto shrink-0 tabular-nums text-ink-faint">
              {event.ms}ms
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
