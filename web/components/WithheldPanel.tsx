import { Panel } from '@/components/ui/Panel';
import type { WithheldRecord } from '@/lib/case-view';

function money(cents?: number) {
  if (typeof cents !== 'number') return null;
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The loudest thing on the page.
 *
 * Anyone can delete everything that matches a name. The claim worth making is
 * that this system knows what it must NOT delete, so the withheld set is given
 * more visual weight than the far larger delete set beside it.
 */
export function WithheldPanel({ withheld }: { withheld: WithheldRecord[] }) {
  if (withheld.length === 0) {
    return (
      <Panel title="Withheld">
        <p className="text-ink-dim">
          Nothing is being withheld - every discovered record is scheduled for
          deletion.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      tone="hold"
      title={
        <span className="flex items-center gap-2">
          <span aria-hidden>⚠</span>
          {withheld.length === 1
            ? '1 record will not be deleted'
            : `${withheld.length} records will not be deleted`}
        </span>
      }
    >
      <ul className="space-y-3">
        {withheld.map((record) => (
          <li
            key={`${record.system}:${record.record_type}:${record.record_id}`}
            className="rounded border border-hold/30 bg-hold-dim/40 px-3.5 py-3"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-semibold text-hold">
                {record.record_type.replace(/_/g, ' ')} #{record.record_id}
              </span>
              {record.order_number ? (
                <span className="text-ink-dim">
                  order {record.order_number}
                </span>
              ) : null}
              {money(record.amount_cents) ? (
                <span className="tabular-nums text-ink">
                  {money(record.amount_cents)}
                </span>
              ) : null}
              <span className="ml-auto text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                {record.system} · {record.disposition}
              </span>
            </div>
            {record.reason ? (
              <p className="mt-1.5 text-ink-dim">
                <span className="text-ink-faint">Reason: </span>
                {record.reason}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
        Withheld records are excluded from the manifest before any adapter runs,
        and the executor rejects them again at the boundary. They survive
        deletion of the account and orders they relate to.
      </p>
    </Panel>
  );
}
