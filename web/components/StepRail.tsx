'use client';

import { PHASES, PHASE_LABELS, PHASE_SECTION_IDS, type Phase } from '@/lib/phases';
import type { StepState } from '@/lib/case-view';

function jumpTo(phase: Phase) {
  document.getElementById(PHASE_SECTION_IDS[phase])?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const MARK: Record<StepState, string> = {
  done: '●', // filled - this happened
  active: '◉', // ringed - this is happening now
  pending: '○', // hollow - not yet
  failed: '✕',
};

const COLOR: Record<StepState, string> = {
  done: 'text-verify',
  active: 'text-accent',
  pending: 'text-ink-faint',
  failed: 'text-danger',
};

export function StepRail({
  steps,
  counts,
  orientation = 'vertical',
}: {
  steps: Record<Phase, StepState>;
  counts?: Partial<Record<Phase, number>>;
  /**
   * The rail is the narrative spine of the page, so it stays visible when the
   * sidebar cannot: narrow layouts render it as a horizontal strip instead of
   * dropping it.
   */
  orientation?: 'vertical' | 'horizontal';
}) {
  const horizontal = orientation === 'horizontal';

  return (
    <ol
      className={
        horizontal
          ? 'flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded border border-line bg-surface px-3 py-2.5'
          : 'space-y-0.5'
      }
    >
      {PHASES.map((phase) => {
        const state = steps[phase];
        const calls = counts?.[phase];
        return (
          <li key={phase}>
            <button
              type="button"
              onClick={() => jumpTo(phase)}
              className={
                horizontal
                  ? 'flex items-baseline gap-1.5'
                  : `flex w-full items-baseline gap-2.5 rounded px-2 py-1.5 text-left hover:bg-raised ${
                      state === 'active' ? 'bg-raised' : ''
                    }`
              }
            >
              <span className={`${COLOR[state]} ${state === 'active' ? 'animate-pulse' : ''}`}>
                {MARK[state]}
              </span>
              <span
                className={
                  state === 'pending'
                    ? 'text-ink-faint'
                    : state === 'active'
                      ? 'text-ink'
                      : 'text-ink-dim'
                }
              >
                {PHASE_LABELS[phase]}
              </span>
              {calls && !horizontal ? (
                <span className="ml-auto text-[10px] text-ink-faint">{calls}</span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
