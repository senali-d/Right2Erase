import { Panel } from '@/components/ui/Panel';
import { Badge } from '@/components/ui/Badge';

export type TruthReport = {
  ok: boolean;
  subject_email: string;
  rows: { key: string; expected: number; found: number; ok: boolean }[];
  unexpected_keys: string[];
  withheld: {
    expected: number;
    found: number;
    missing: string[];
    unexpected: string[];
    ok: boolean;
  };
  must_not_touch: { id: number; email: string; swept: boolean }[];
  /** Set when the subject's rows are already gone, so this is the cached pre-execution report. */
  post_execution?: boolean;
};

/**
 * Independent confirmation, not self-assessment.
 *
 * The expected column is computed straight from Postgres by tooling the agent
 * cannot reach; the found column is what the agent actually recorded. The decoy
 * row is called out by name because sweeping up a different person who happens
 * to share a display name is the specific failure this fixture was built to
 * catch.
 */
export function VerificationPanel({ truth }: { truth: TruthReport }) {
  return (
    <Panel
      tone={truth.ok ? 'verify' : 'danger'}
      title="Verified against ground truth"
      aside={
        <Badge tone={truth.ok ? 'verify' : 'danger'}>
          {truth.ok ? 'matches' : 'mismatch'}
        </Badge>
      }
    >
      <table className="w-full">
        <thead>
          <tr className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">
            <th className="pb-2 text-left font-normal">Target</th>
            <th className="pb-2 text-right font-normal">Expected</th>
            <th className="pb-2 text-right font-normal">Agent</th>
          </tr>
        </thead>
        <tbody>
          {truth.rows.map((row) => (
            <tr key={row.key} className="border-t border-line">
              <td className="py-1.5">
                <span className={row.ok ? 'text-verify' : 'text-danger'}>
                  {row.ok ? '✓' : '✗'}
                </span>
                <span className="ml-2 text-ink">
                  {row.key.replace(/_/g, ' ')}
                </span>
              </td>
              <td className="py-1.5 text-right tabular-nums text-ink-dim">
                {row.expected}
              </td>
              <td
                className={`py-1.5 text-right tabular-nums ${row.ok ? 'text-ink' : 'text-danger'}`}
              >
                {row.found}
              </td>
            </tr>
          ))}
          <tr className="border-t border-line">
            <td className="py-1.5">
              <span
                className={truth.withheld.ok ? 'text-verify' : 'text-danger'}
              >
                {truth.withheld.ok ? '✓' : '✗'}
              </span>
              <span className="ml-2 text-hold">withheld records</span>
            </td>
            <td className="py-1.5 text-right tabular-nums text-ink-dim">
              {truth.withheld.expected}
            </td>
            <td className="py-1.5 text-right tabular-nums text-ink">
              {truth.withheld.found}
            </td>
          </tr>
        </tbody>
      </table>

      {truth.unexpected_keys.length ? (
        <p className="mt-3 text-danger">
          Unexpected delete target(s): {truth.unexpected_keys.join(', ')}
        </p>
      ) : null}

      {truth.must_not_touch.length ? (
        <div className="mt-4 border-t border-line pt-3">
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
            Must not touch
          </div>
          <ul className="mt-2 space-y-1">
            {truth.must_not_touch.map((account) => (
              <li key={account.id} className="flex items-baseline gap-2">
                <span className={account.swept ? 'text-danger' : 'text-verify'}>
                  {account.swept ? '✗' : '✓'}
                </span>
                <span className="text-ink">{account.email}</span>
                <span className="text-ink-faint">account {account.id}</span>
                <span
                  className={`ml-auto ${account.swept ? 'text-danger' : 'text-ink-dim'}`}
                >
                  {account.swept
                    ? 'SWEPT UP - unrelated person in the plan'
                    : 'untouched'}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            This account shares the subject’s display name. It must never appear
            in the plan.
          </p>
        </div>
      ) : null}

      {truth.post_execution ? (
        <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-faint">
          Computed before execution. The subject’s rows no longer exist in
          PostgreSQL, so ground truth cannot be recomputed - that absence is
          itself the erasure taking effect.
        </p>
      ) : null}
    </Panel>
  );
}
