'use client';

import { useState } from 'react';
import { Panel } from '@/components/ui/Panel';
import type { CaseView } from '@/lib/case-view';

const SYSTEM_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  minio: 'MinIO',
  billing: 'Billing',
};

export function ApprovalPanel({
  view,
  onApprove,
  submitting,
  error,
}: {
  view: CaseView;
  onApprove: (approvedBy: string) => void;
  submitting: boolean;
  error?: string;
}) {
  const [approvedBy, setApprovedBy] = useState('demo-operator');
  const [confirming, setConfirming] = useState(false);
  const plan = view.plan;

  if (!plan) {
    return (
      <Panel title="Approval">
        <p className="text-ink-dim">
          No plan yet. The gate opens once discovery and rehearsal finish.
        </p>
      </Panel>
    );
  }

  // A plan that deletes nothing must never present a destructive button. The
  // agent refuses to open a case for a subject with no data at all, so this is
  // reachable only for a subject whose data was already erased.
  if (plan.delete_count === 0) {
    return (
      <Panel title="Nothing to erase">
        <p className="text-ink-dim">
          This plan contains no deletions
          {plan.withheld_count > 0
            ? `, and ${plan.withheld_count} record${plan.withheld_count === 1 ? '' : 's'} would be withheld`
            : ''}
          . There is nothing to approve.
        </p>
      </Panel>
    );
  }

  return (
    <Panel tone="danger" title="⚠ Approval required">
      <p className="text-ink-dim">This operation permanently deletes:</p>

      <dl className="mt-3 space-y-1.5">
        {Object.entries(plan.by_system).map(([system, count]) => (
          <div
            key={system}
            className="flex items-baseline justify-between border-b border-line pb-1.5"
          >
            <dt className="text-ink">{SYSTEM_LABEL[system] ?? system}</dt>
            <dd className="tabular-nums text-ink">{count.toLocaleString()}</dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between pt-1">
          <dt className="text-hold">Withheld</dt>
          <dd className="tabular-nums text-hold">
            {plan.withheld_count.toLocaleString()}
          </dd>
        </div>
      </dl>

      <div className="mt-5 space-y-1 border-t border-line pt-4">
        <div className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          Plan hash
        </div>
        <code className="block break-all text-[11px] leading-relaxed text-ink-dim">
          {plan.plan_hash}
        </code>
      </div>

      <div className="mt-4">
        <label
          className="text-[10px] uppercase tracking-[0.14em] text-ink-faint"
          htmlFor="approved-by"
        >
          Approving as
        </label>
        <input
          id="approved-by"
          value={approvedBy}
          onChange={(event) => setApprovedBy(event.target.value)}
          disabled={submitting}
          className="mt-1 w-full rounded border border-line-bright bg-ground px-3 py-2 text-ink outline-none focus:border-accent disabled:opacity-50"
        />
        <p className="mt-1 text-[10px] text-ink-faint">
          Recorded on the approval and re-checked by Right2Erase before
          execution.
        </p>
      </div>

      {error ? <p className="mt-3 text-danger">{error}</p> : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {confirming ? (
          <>
            <span className="text-danger">This cannot be undone.</span>
            <button
              type="button"
              onClick={() => onApprove(approvedBy.trim())}
              disabled={submitting || !approvedBy.trim()}
              className="rounded bg-danger px-4 py-2 font-semibold text-ground disabled:opacity-50"
            >
              {submitting ? 'Executing…' : 'Confirm & execute'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={submitting}
              className="rounded border border-line-bright px-4 py-2 text-ink-dim disabled:opacity-50"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={submitting}
            className="rounded border border-danger/60 bg-danger-dim px-4 py-2 font-semibold text-danger disabled:opacity-50"
          >
            Approve &amp; execute
          </button>
        )}
      </div>
    </Panel>
  );
}
