import type { SystemCard } from '@/lib/case-view';

export function SystemCards({ systems, investigated }: { systems: SystemCard[]; investigated: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {systems.map((system) => (
        <div key={system.key} className="rounded border border-line bg-surface px-4 py-3.5">
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">{system.label}</div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold tabular-nums text-ink">
              {system.count.toLocaleString()}
            </span>
            <span className="text-[11px] text-ink-dim">{system.unit}</span>
          </div>
          <div className={`mt-2 text-[10px] ${investigated ? 'text-verify' : 'text-ink-faint'}`}>
            {investigated ? '✓ investigated' : 'searching…'}
          </div>
        </div>
      ))}
    </div>
  );
}
