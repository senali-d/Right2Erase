'use client';

import { useState } from 'react';
import type { RecordGroup, SystemCard } from '@/lib/case-view';

/**
 * The four systems, and what is actually in them.
 *
 * The cards used to show only a count. That is enough to say an investigation
 * happened and not enough to approve one: "14 records" gives an operator no
 * way to tell whether the right fourteen were found, and no way to answer the
 * first question anyone asks, which is "which ones?". Opening a card names
 * them, grouped by kind so the page stays readable when a real subject turns
 * out to have hundreds.
 */
export function SystemCards({
  systems,
  investigated,
}: {
  systems: SystemCard[];
  investigated: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const opened = systems.find((system) => system.key === open) ?? null;

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {systems.map((system) => {
          const expandable = system.groups.length > 0;
          const isOpen = open === system.key;
          return (
            <button
              key={system.key}
              type="button"
              // A card with nothing behind it stays inert rather than opening
              // an empty drawer.
              disabled={!expandable}
              onClick={() => setOpen(isOpen ? null : system.key)}
              aria-expanded={isOpen}
              className={`rounded border bg-surface px-4 py-3.5 text-left transition-colors ${
                isOpen ? 'border-accent' : 'border-line'
              } ${expandable ? 'hover:border-line-bright' : 'cursor-default'}`}
            >
              <div className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                {system.label}
              </div>
              <div className="mt-2 flex items-baseline gap-1.5">
                <span className="text-2xl font-semibold tabular-nums text-ink">
                  {system.count.toLocaleString()}
                </span>
                <span className="text-[11px] text-ink-dim">{system.unit}</span>
              </div>
              <div className="mt-2 flex items-baseline justify-between gap-2">
                <span
                  className={`text-[10px] ${investigated ? 'text-verify' : 'text-ink-faint'}`}
                >
                  {investigated ? '✓ investigated' : 'searching…'}
                </span>
                {expandable ? (
                  <span className="text-[10px] text-ink-faint">
                    {isOpen ? 'hide' : 'show'}
                  </span>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>

      {opened ? (
        <div className="mt-3 rounded border border-line bg-surface">
          <div className="border-b border-line px-4 py-2.5 text-[10px] uppercase tracking-[0.14em] text-ink-faint">
            {opened.label} · {opened.count.toLocaleString()} {opened.unit}
          </div>
          <div className="divide-y divide-line">
            {opened.groups.map((group) => (
              <Group key={group.record_type} group={group} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Group({ group }: { group: RecordGroup }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-ink">{group.record_type.replace(/_/g, ' ')}</span>
        <span className="tabular-nums text-[11px] text-ink-dim">
          {group.count.toLocaleString()}
        </span>
      </div>

      <ul className="mt-1.5 space-y-0.5">
        {group.items.map((item) => (
          <li
            key={`${group.record_type}:${item.record_id}`}
            className="flex items-baseline gap-2 text-[11px]"
          >
            <span className="text-ink-faint">·</span>
            {/* Wraps rather than truncates: an object key is the only link
                back to an orphaned file, so cutting it off would hide the one
                detail that makes that record checkable. */}
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
  );
}
