'use client';

import { useState } from 'react';
import type { RecordGroup } from '@/lib/case-view';

const SYSTEM_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  minio: 'MinIO',
  billing: 'Billing',
};

/**
 * A disclosure that opens the record list.
 *
 * Rendered as a real control rather than a line of dim text with a hover
 * underline. Hover is not an affordance - it only tells you a thing was
 * clickable once you have already guessed - and at the approval gate the
 * consequence of not guessing is that an operator approves a deletion without
 * ever discovering they could have read it.
 */
export function RecordDisclosure({
  groups,
  label,
  labelOpen,
  showSystem = false,
}: {
  groups: RecordGroup[];
  label: string;
  labelOpen: string;
  showSystem?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (groups.length === 0) return null;

  const total = groups.reduce((sum, group) => sum + group.count, 0);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded border border-line-bright bg-surface px-3 py-2 text-left text-ink transition-colors hover:border-accent hover:text-accent"
      >
        <span
          aria-hidden
          className={`text-[10px] transition-transform ${open ? 'rotate-90' : ''}`}
        >
          ▶
        </span>
        <span className="flex-1">{open ? labelOpen : label}</span>
        <span className="tabular-nums text-[11px] text-ink-faint">
          {total.toLocaleString()}
        </span>
      </button>

      {open ? (
        <div className="mt-2">
          <RecordGroups groups={groups} showSystem={showSystem} />
        </div>
      ) : null}
    </div>
  );
}

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
