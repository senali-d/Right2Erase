import { Panel, Field } from '@/components/ui/Panel';
import { Badge } from '@/components/ui/Badge';
import type { CaseView } from '@/lib/case-view';

const SYSTEM_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  minio: 'MinIO',
  billing: 'Billing',
};

export function CertificatePanel({ view }: { view: CaseView }) {
  const cert = view.certificate;
  if (!cert) return null;

  return (
    <Panel
      tone="verify"
      title="✓ Erasure complete"
      aside={<Badge tone="verify">certificate issued</Badge>}
    >
      <dl className="space-y-1.5">
        {Object.entries(cert.by_system).map(([system, count]) => (
          <div
            key={system}
            className="flex items-baseline justify-between border-b border-line pb-1.5"
          >
            <dt className="text-ink">{SYSTEM_LABEL[system] ?? system}</dt>
            <dd className="tabular-nums text-verify">
              {count.toLocaleString()} deleted
            </dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between pt-1">
          <dt className="text-hold">Withheld</dt>
          <dd className="tabular-nums text-hold">
            {cert.withheld_count.toLocaleString()}
          </dd>
        </div>
      </dl>

      <div className="mt-5 grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
        <Field label="Approved by">{cert.approved_by}</Field>
        <Field label="Executed at">
          {new Date(cert.executed_at).toLocaleString()}
        </Field>
      </div>

      <div className="mt-4 space-y-1">
        <div className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          Plan hash
        </div>
        <code className="block break-all text-[11px] leading-relaxed text-ink-dim">
          {cert.plan_hash}
        </code>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
        The certificate lists the actions each adapter confirmed, not the
        actions that were planned. It is immutable: the case store rejects any
        update or delete against it.
      </p>
    </Panel>
  );
}
