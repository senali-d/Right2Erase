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
  navigable = true,
}: {
  steps: Record<Phase, StepState>;
  counts?: Partial<Record<Phase, number>>;
  /**
   * The rail is the narrative spine of the page, so it stays visible when the
   * sidebar cannot: narrow layouts render it as a horizontal strip instead of
   * dropping it.
   */
  orientation?: 'vertical' | 'horizontal';
  /**
   * The case page has a section for every phase to scroll to; the run page
   * (no case id yet, or a run that failed before getting one) does not, so a
   * click there would jump nowhere. Render plain rows instead of dead buttons.
   */
  navigable?: boolean;
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
        const Row = navigable ? 'button' : 'div';
        return (
          <li key={phase}>
            <Row
              type={navigable ? 'button' : undefined}
              onClick={navigable ? () => jumpTo(phase) : undefined}
              className={
                horizontal
                  ? 'flex items-baseline gap-1.5'
                  : `flex w-full items-baseline gap-2.5 rounded px-2 py-1.5 text-left ${
                      navigable ? 'hover:bg-raised' : ''
                    } ${state === 'active' ? 'bg-raised' : ''}`
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
            </Row>
          </li>
        );
      })}
    </ol>
  );
}
