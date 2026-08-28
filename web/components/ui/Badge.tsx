const TONES = {
  neutral: 'border-line-bright text-ink-dim',
  accent: 'border-accent/50 text-accent',
  hold: 'border-hold/60 text-hold bg-hold-dim',
  danger: 'border-danger/60 text-danger bg-danger-dim',
  verify: 'border-verify/60 text-verify bg-verify-dim',
} as const;

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: keyof typeof TONES;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}
