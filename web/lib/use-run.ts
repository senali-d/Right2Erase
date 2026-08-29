'use client';

import { useEffect, useState } from 'react';
import type { Run } from './run-store';

const POLL_MS = 1000;

// A run that was just created can 404 briefly - the dev server compiles the
// route on first request, and a redirect can land the browser here before the
// POST's response is even processed. Treat early failures as transient and keep
// polling; only surface an error once it is clearly not coming back.
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Polls one agent run until it reaches a terminal state.
 *
 * Polling rather than streaming: each phase of a run lasts seconds, the run
 * record is small, and a poll survives a page refresh with no reconnect logic.
 */
export function useRun(runId: string | null): {
  run: Run | null;
  error: string | null;
} {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    function retry(message: string) {
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) setError(message);
      timer = setTimeout(poll, POLL_MS);
    }

    async function poll() {
      try {
        const response = await fetch(`/api/runs/${runId}`);
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          retry(payload.error ?? 'failed to read run');
          return;
        }
        failures = 0;
        setRun(payload.run);
        setError(null);
        if (payload.run.status === 'running') timer = setTimeout(poll, POLL_MS);
      } catch {
        if (!cancelled) retry('cannot reach the server');
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  return { run, error };
}
