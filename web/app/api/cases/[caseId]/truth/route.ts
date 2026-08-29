import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { caseGet } from '@/lib/mcp';
import {
  computeTruth,
  DEFAULT_DATABASE_URL,
} from '../../../../../../fixture/scripts/truth-core.js';
import { buildManifest } from '../../../../../../agent/build-plan-manifest.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Scores a case against ground truth.
 *
 * truth-core.js derives the correct answer straight from Postgres, having never
 * seen the agent's findings; buildManifest buckets those findings into the same
 * closed key set. Comparing the two is the difference between the agent
 * claiming it worked and something independent confirming it.
 *
 * This is operator-side and stays that way: it is reachable only from this
 * route, is not an MCP tool, and nothing under agent/ imports it. The agent
 * must never be able to read the answer it is being graded on.
 *
 * The report is cached per case on first computation because ground truth is
 * only computable while the subject's rows still exist. After a successful
 * erasure the source data is gone - by design - and recomputing would fail with
 * "no account for ...". Caching keeps the verification visible on a completed
 * case, which is exactly when someone most wants to see it.
 */

type TruthRow = { key: string; expected: number; found: number; ok: boolean };

function cachePath(caseId: string): string {
  const dir =
    process.env.OUBLIETTE_TRUTH_DIR ||
    path.resolve(process.cwd(), '..', '.oubliette', 'truth');
  // caseId comes from the route path; keep it to the uuid shape the case store
  // issues so it can never walk out of the cache directory.
  const safe = /^[0-9a-fA-F-]{36}$/.test(caseId) ? caseId : null;
  if (!safe) throw new Error(`invalid case id: ${caseId}`);
  return path.join(dir, `${safe}.json`);
}

function readCache(caseId: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(cachePath(caseId), 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(caseId: string, report: unknown): void {
  try {
    const file = cachePath(caseId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
  } catch {
    // The cache is a convenience; a failed write must not fail the response.
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const { caseId } = await params;

  let record;
  try {
    record = await caseGet(caseId);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'failed to read case' },
      { status: 502 },
    );
  }
  if (!record)
    return NextResponse.json(
      { error: `case not found: ${caseId}` },
      { status: 404 },
    );

  let expected;
  try {
    expected = await computeTruth({
      connectionString: process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
      email: record.subject_email,
    });
  } catch (error) {
    // The subject being absent from Postgres is the expected outcome of a
    // successful erasure, not a fault. Serve the report computed before
    // execution rather than dropping the verification entirely.
    const cached = readCache(caseId);
    if (cached)
      return NextResponse.json({
        truth: { ...(cached as object), post_execution: true },
      });
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'failed to compute ground truth',
      },
      { status: 502 },
    );
  }

  const actual = buildManifest(record.findings ?? []);

  const rows: TruthRow[] = Object.entries(
    expected.delete as Record<string, number>,
  ).map(([key, value]) => {
    const found = (actual.delete as Record<string, number>)[key] ?? 0;
    return { key, expected: value, found, ok: found === value };
  });

  // A matching count per key is not enough on its own: an extra target would
  // make an over-broad plan look correct, so the manifest is a closed set.
  const expectedKeys = new Set(
    Object.keys(expected.delete as Record<string, number>),
  );
  const unexpectedKeys = Object.keys(
    actual.delete as Record<string, number>,
  ).filter((key) => !expectedKeys.has(key));

  // Compare withheld records by durable identity rather than by count, which
  // would accept a substituted record.
  const identity = (r: { table?: string; id?: unknown }) =>
    r && r.table != null && r.id != null ? `${r.table}:${r.id}` : null;
  const expectedWithheld = new Set(
    (expected.withhold as { table: string; id: unknown }[]).map(identity),
  );
  const foundWithheld = new Set(
    (actual.withhold as { table: string; id: unknown }[]).map(identity),
  );
  const missingWithheld = [...expectedWithheld].filter(
    (id) => !foundWithheld.has(id),
  );
  const unexpectedWithheld = [...foundWithheld].filter(
    (id) => !expectedWithheld.has(id),
  );

  // The decoy shares the subject's display name. Sweeping it up is the failure
  // this whole fixture exists to catch, so it gets its own verdict rather than
  // being folded into a count.
  const erasedAccountIds = new Set(
    (record.findings ?? [])
      .filter(
        (f) =>
          f.system === 'postgres' &&
          f.record_type === 'account' &&
          f.disposition === 'erase',
      )
      .map((f) => String(f.record_id)),
  );
  const mustNotTouch = (
    expected.must_not_touch as { id: number; email: string }[]
  ).map((account) => ({
    ...account,
    swept: erasedAccountIds.has(String(account.id)),
  }));

  const truth = {
    ok:
      rows.every((row) => row.ok) &&
      unexpectedKeys.length === 0 &&
      missingWithheld.length === 0 &&
      unexpectedWithheld.length === 0 &&
      mustNotTouch.every((account) => !account.swept),
    subject_email: record.subject_email,
    rows,
    unexpected_keys: unexpectedKeys,
    withheld: {
      expected: expectedWithheld.size,
      found: foundWithheld.size,
      missing: missingWithheld,
      unexpected: unexpectedWithheld,
      ok: missingWithheld.length === 0 && unexpectedWithheld.length === 0,
    },
    must_not_touch: mustNotTouch,
  };

  writeCache(caseId, truth);
  return NextResponse.json({ truth });
}
