'use client';

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useRun } from '@/lib/use-run';
import { StepRail } from '@/components/StepRail';
import { ToolFeed } from '@/components/ToolFeed';
import type { StepState } from '@/lib/case-view';
import { PHASES, phaseIndex, type Phase } from '@/lib/phases';

/**
 * The gap between "open a case" and having a case id to link to.
 *
 * case_create is the agent's second call, so this page is usually on screen for
 * well under a second - but it shows real progress rather than a spinner, and
 * it is where an identity collision surfaces, since that check deliberately
 * runs before any case exists to fail against.
 */
function railFromRun(
  current: Phase,
  running: boolean,
): Record<Phase, StepState> {
  const currentIndex = phaseIndex(current);
  return Object.fromEntries(
    PHASES.map((phase) => {
      const index = phaseIndex(phase);
      if (index < currentIndex) return [phase, 'done'];
      if (index === currentIndex) return [phase, running ? 'active' : 'done'];
      return [phase, 'pending'];
    }),
  ) as Record<Phase, StepState>;
}

export default function RunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = use(params);
  const router = useRouter();
  const { run, error } = useRun(runId);

  useEffect(() => {
    if (run?.case_id) router.replace(`/cases/${run.case_id}?run=${runId}`);
  }, [run?.case_id, runId, router]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-14">
      <Link href="/" className="text-[11px] text-ink-faint hover:text-ink-dim">
        ← all cases
      </Link>
      <h1 className="mt-4 text-lg font-semibold tracking-[0.2em] text-ink">
        RIGHT2ERASE
      </h1>
      <p className="mt-1.5 text-ink-dim">
        {run?.subject_email
          ? `Investigating ${run.subject_email}…`
          : 'Starting investigation…'}
      </p>

      {run?.status === 'failed' ? (
        <div className="mt-8 rounded border border-danger/50 bg-danger-dim/40 px-4 py-3.5">
          <p className="font-semibold text-danger">Investigation stopped</p>
          <p className="mt-1.5 text-ink-dim">{run.error}</p>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            Identity is resolved before a case is created, so a collision stops
            here rather than leaving an empty case behind.
          </p>
        </div>
      ) : null}

      {error ? <p className="mt-6 text-danger">{error}</p> : null}

      {run ? (
        <div className="mt-8 space-y-6">
          <StepRail
            steps={railFromRun(run.phase, run.status === 'running')}
            counts={Object.fromEntries(
              Object.entries(run.phases).map(([phase, state]) => [
                phase,
                state.tool_calls,
              ]),
            )}
            navigable={false}
          />
          <ToolFeed events={run.recent} total={run.tool_calls} />
        </div>
      ) : null}
    </main>
  );
}
