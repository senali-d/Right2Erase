'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import type { CaseSummary } from '@/lib/mcp';
import { STATUS_TONE } from '@/lib/status';

export default function Home() {
  const router = useRouter();
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [email, setEmail] = useState('ravi.sharma@example.com');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<CaseSummary | null>(null);

  async function refresh() {
    try {
      const response = await fetch('/api/cases');
      const payload = await response.json();
      if (response.ok) setCases(payload.cases ?? []);
      else setError(payload.error ?? 'failed to load cases');
    } catch {
      setError(
        'cannot reach the Right2Erase MCP server - is it running on :4014?',
      );
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function open(force: boolean) {
    setBusy(true);
    setError(null);
    setDuplicate(null);
    try {
      const response = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject_email: email.trim(), force }),
      });
      const payload = await response.json();
      if (response.status === 409 && payload.existing_case) {
        setDuplicate(payload.existing_case);
        return;
      }
      if (!response.ok) {
        setError(payload.error ?? 'failed to open a case');
        return;
      }
      router.push(`/runs/${payload.run_id}`);
    } catch {
      setError('failed to reach the erasure agent');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-14">
      <header>
        <h1 className="text-lg font-semibold tracking-[0.2em] text-ink">
          RIGHT2ERASE
        </h1>
        <p className="mt-1.5 text-ink-dim">Data erasure control center</p>
      </header>

      <section className="mt-10 rounded border border-line bg-surface p-5">
        <label
          htmlFor="subject"
          className="text-[10px] uppercase tracking-[0.14em] text-ink-faint"
        >
          Subject email
        </label>
        <div className="mt-2 flex flex-wrap gap-3">
          <input
            id="subject"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !busy && email.trim())
                void open(false);
            }}
            disabled={busy}
            className="min-w-64 flex-1 rounded border border-line-bright bg-ground px-3 py-2 text-ink outline-none focus:border-accent disabled:opacity-50"
            placeholder="person@example.com"
          />
          <button
            type="button"
            onClick={() => void open(false)}
            disabled={busy || !email.trim()}
            className="rounded bg-accent px-4 py-2 font-semibold text-ground disabled:opacity-50"
          >
            {busy ? 'Opening…' : 'Open erasure case'}
          </button>
        </div>

        {duplicate ? (
          <div className="mt-4 rounded border border-hold/40 bg-hold-dim/40 px-3.5 py-3">
            <p className="text-hold">
              A case already exists for {duplicate.subject_email}.
            </p>
            <p className="mt-1 text-[11px] text-ink-faint">
              Cases are permanent audit records with no delete path, so opening
              a second one for the same person cannot be undone.
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <Link
                href={`/cases/${duplicate.id}`}
                className="rounded border border-line-bright px-3 py-1.5 text-ink"
              >
                Open existing case
              </Link>
              <button
                type="button"
                onClick={() => void open(true)}
                disabled={busy}
                className="rounded border border-hold/60 px-3 py-1.5 text-hold disabled:opacity-50"
              >
                Open a second case anyway
              </button>
            </div>
          </div>
        ) : null}

        {error ? <p className="mt-3 text-danger">{error}</p> : null}
      </section>

      <section className="mt-10">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          Cases
        </h2>
        {cases.length === 0 ? (
          <p className="mt-3 text-ink-dim">No cases yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line rounded border border-line bg-surface">
            {cases.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/cases/${item.id}`}
                  className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3 hover:bg-raised"
                >
                  <span className="text-ink">{item.subject_email}</span>
                  <Badge tone={STATUS_TONE[item.status] ?? 'neutral'}>
                    {item.status}
                  </Badge>
                  <span className="tabular-nums text-ink-faint">
                    {item.finding_count.toLocaleString()} findings
                  </span>
                  <span className="ml-auto text-[11px] text-ink-faint">
                    {new Date(item.created_at).toLocaleString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
