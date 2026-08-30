import type { RecordGroup } from '@/lib/case-view';

const SYSTEM_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  minio: 'MinIO',
  billing: 'Billing',
};

/**
 * A list of records, grouped by kind and named.
 *
 * Shared by the three places that answer "which ones?" - the system cards
 * during discovery, the plan at the approval gate, and the certificate
 * afterwards. They are the same question asked at three moments, so they read
 * the same way rather than three near-identical blocks drifting apart.
 */
export function RecordGroups({
  groups,
  /** Worth showing only where the list spans systems, as the plan does. */
  showSystem = false,
}: {
  groups: RecordGroup[];
  showSystem?: boolean;
}) {
  return (
    <div className="divide-y divide-line rounded border border-line">
      {groups.map((group) => (
        <div
          key={`${group.system}:${group.record_type}`}
          className="px-3 py-2.5"
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-ink">
              {group.record_type.replace(/_/g, ' ')}
              {showSystem ? (
                <span className="ml-2 text-[10px] text-ink-faint">
                  {SYSTEM_LABEL[group.system] ?? group.system}
                </span>
              ) : null}
            </span>
            <span className="tabular-nums text-[11px] text-ink-dim">
              {group.count.toLocaleString()}
            </span>
          </div>

          <ul className="mt-1 space-y-0.5">
            {group.items.map((item) => (
              <li
                key={`${group.record_type}:${item.record_id}`}
                className="flex items-baseline gap-2 text-[11px]"
              >
                <span className="text-ink-faint">·</span>
                {/* Wraps rather than truncates: an object key is the only link
                    back to an orphaned file, so cutting it off would hide the
                    one detail that makes that record checkable. */}
                <span className="break-all text-ink-dim">{item.label}</span>
              </li>
            ))}
            {group.hidden > 0 ? (
              <li className="pl-4 text-[11px] text-ink-faint">
                + {group.hidden.toLocaleString()} more
              </li>
            ) : null}
          </ul>

          {group.note ? (
            <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">
              {group.note}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
