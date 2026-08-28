'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useRun } from '@/lib/use-run';
import { StepRail } from '@/components/StepRail';
import { SystemCards } from '@/components/SystemCards';
import { WithheldPanel } from '@/components/WithheldPanel';
import { SandboxPanel } from '@/components/SandboxPanel';
import { ApprovalPanel } from '@/components/ApprovalPanel';
import { CertificatePanel } from '@/components/CertificatePanel';
import { VerificationPanel, type TruthReport } from '@/components/VerificationPanel';
import { ToolFeed } from '@/components/ToolFeed';
import { Badge } from '@/components/ui/Badge';
import type { CaseView } from '@/lib/case-view';

const STATUS_TONE = {
  discovered: 'accent',
  planned: 'hold',
  approved: 'hold',
  executing: 'accent',
  completed: 'verify',
  failed: 'danger',
} as const;

export default function CasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = use(params);
  const router = useRouter();
  const runId = useSearchParams().get('run');

  const { run } = useRun(runId);
  const [view, setView] = useState<CaseView | null>(null);
  const [truth, setTruth] = useState<TruthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  const loadCase = useCallback(async () => {
    try {
      const response = await fetch(`/api/cases/${caseId}`);
      const payload = await response.json();
      if (response.ok) setView(payload.view);
      else setError(payload.error ?? 'failed to load case');
    } catch {
      setError('cannot reach the Oubliette MCP server - is it running on :4014?');
    }
  }, [caseId]);

  useEffect(() => {
    void loadCase();
  }, [loadCase]);

  // Re-read the case whenever the agent crosses a phase boundary or finishes,
  // so counts, the plan, and the certificate appear as they are written rather
  // than on a fixed timer. Depending on the run object itself would refetch on
  // every poll tick, since each poll yields a fresh object.
  const runPhase = run?.phase;
  const runStatus = run?.status;
  useEffect(() => {
    if (runStatus) void loadCase();
  }, [runPhase, runStatus, loadCase]);

  // Ground truth only becomes meaningful once discovery has produced a plan.
  useEffect(() => {
    if (!view?.plan || truth) return;
    void (async () => {
      try {
        const response = await fetch(`/api/cases/${caseId}/truth`);
        const payload = await response.json();
        if (response.ok) setTruth(payload.truth);
      } catch {
        // Ground truth needs Postgres directly; its absence must not break the page.
      }
    })();
  }, [view?.plan, truth, caseId]);

  async function approve(approvedBy: string) {
    if (!view?.plan) return;
    setSubmitting(true);
    setApproveError(undefined);
    try {
      const response = await fetch(`/api/cases/${caseId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan_hash: view.plan.plan_hash, approved_by: approvedBy }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setApproveError(payload.error ?? 'approval was refused');
        return;
      }
      router.replace(`/cases/${caseId}?run=${payload.run_id}`);
    } catch {
      setApproveError('failed to reach the erasure agent');
    } finally {
      setSubmitting(false);
    }
  }

  if (error) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-14">
        <Link href="/" className="text-[11px] text-ink-faint hover:text-ink-dim">
          ← all cases
        </Link>
        <p className="mt-6 text-danger">{error}</p>
      </main>
    );
  }

  if (!view) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-14">
        <p className="text-ink-dim">Loading case…</p>
      </main>
    );
  }

  const running = run?.status === 'running';
  const executed = Boolean(view.certificate);

  return (
    <div className="mx-auto flex max-w-6xl gap-8 px-6 py-10">
      <aside className="sticky top-10 hidden h-fit w-52 shrink-0 lg:block">
        <Link href="/" className="text-[11px] text-ink-faint hover:text-ink-dim">
          ← all cases
        </Link>
        <h1 className="mt-4 text-sm font-semibold tracking-[0.2em] text-ink">OUBLIETTE</h1>
        <div className="mt-6">
          <StepRail
            steps={view.steps}
            counts={
              run
                ? Object.fromEntries(
                    Object.entries(run.phases).map(([phase, state]) => [phase, state.tool_calls]),
                  )
                : undefined
            }
          />
        </div>
        {run ? (
          <div className="mt-6">
            <ToolFeed events={run.recent} total={run.tool_calls} />
          </div>
        ) : null}
      </aside>

      <main className="min-w-0 flex-1 space-y-6">
        <header className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <div>
            <h2 className="text-xl font-semibold text-ink">
              {view.subject_name ?? view.subject_email}
            </h2>
            {view.subject_name ? (
              <p className="mt-0.5 text-ink-dim">{view.subject_email}</p>
            ) : null}
          </div>
          <div className="ml-auto flex items-center gap-3">
            <Badge tone={STATUS_TONE[view.status] ?? 'neutral'}>
              {running ? `${view.status} · working` : view.status}
            </Badge>
            <code className="text-[11px] text-ink-faint">{view.case_id.slice(0, 8)}</code>
          </div>
        </header>

        <div className="lg:hidden">
          <StepRail steps={view.steps} orientation="horizontal" />
        </div>

        <SystemCards systems={view.systems} investigated={view.discovery_complete} />

        <WithheldPanel withheld={view.withheld} />

        <SandboxPanel rehearsal={run?.rehearsal} running={running && !run?.rehearsal} />

        {run?.status === 'failed' ? (
          <div className="rounded border border-danger/50 bg-danger-dim/40 px-4 py-3.5">
            <p className="font-semibold text-danger">Run failed</p>
            <p className="mt-1.5 break-words text-ink-dim">{run.error}</p>
          </div>
        ) : null}

        {executed ? (
          <CertificatePanel view={view} />
        ) : (
          <ApprovalPanel view={view} onApprove={approve} submitting={submitting || running} error={approveError} />
        )}

        {truth ? <VerificationPanel truth={truth} /> : null}
      </main>
    </div>
  );
}
