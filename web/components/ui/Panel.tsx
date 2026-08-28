import type { ReactNode } from 'react';

type Tone = 'neutral' | 'hold' | 'danger' | 'verify';

const TONE_BORDER: Record<Tone, string> = {
  neutral: 'border-line',
  hold: 'border-hold/50',
  danger: 'border-danger/50',
  verify: 'border-verify/40',
};

const TONE_TITLE: Record<Tone, string> = {
  neutral: 'text-ink-dim',
  hold: 'text-hold',
  danger: 'text-danger',
  verify: 'text-verify',
};

export function Panel({
  title,
  aside,
  tone = 'neutral',
  children,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <section className={`rounded border ${TONE_BORDER[tone]} bg-surface`}>
      {title ? (
        <header className="flex items-baseline justify-between gap-4 border-b border-line px-4 py-2.5">
          <h2 className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${TONE_TITLE[tone]}`}>
            {title}
          </h2>
          {aside ? <div className="text-[11px] text-ink-faint">{aside}</div> : null}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">{label}</div>
      <div className="mt-1 text-ink">{children}</div>
    </div>
  );
}
