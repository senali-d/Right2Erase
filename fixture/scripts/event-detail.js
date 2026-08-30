/**
 * Read event-log rows by id, for display.
 *
 * Lives beside truth-core.js because it is the same kind of thing: operator
 * tooling that reads ShopKart directly, by a route no agent tool exposes. It
 * exists because an event finding stores nothing but its id - the adapter
 * returns ids rather than hundreds of rows on purpose - so the control center
 * has no way to show which address an entry was filed under, which is exactly
 * what the identity-chain case is about.
 *
 * Read-only and by id only. It cannot widen what the agent sees, and nothing
 * here writes.
 */
import pg from 'pg';
import { DEFAULT_DATABASE_URL } from './truth-core.js';

/** Largest value a PostgreSQL bigint - and so a BIGSERIAL id - can hold. */
const BIGINT_MAX = 9223372036854775807n;

/**
 * The canonical decimal spelling of a positive bigint id, or null.
 *
 * Exported because the caller has to key its lookup the same way this keys its
 * query. Two spellings of one id are the failure here: "007" and "7" pass the
 * same validation and select the same row, but PostgreSQL returns the id as 7,
 * so a lookup by the original string misses and the record silently renders
 * unenriched. Normalising once, in the place that also builds the query, is
 * what stops the two sides drifting.
 *
 * Out-of-range values are rejected here rather than sent: bigint[] rejects the
 * whole array if any element overflows, so one impossible id would suppress
 * enrichment for every valid one alongside it.
 *
 * @param {string | number | bigint} value
 * @returns {string | null}
 */
export function canonicalEventId(value) {
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = BigInt(raw);
  if (parsed <= 0n || parsed > BIGINT_MAX) return null;
  return parsed.toString();
}

/**
 * @param {object} [options]
 * @param {string} [options.connectionString]
 * @param {Array<string | number>} [options.ids]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function fetchEventRows({
  connectionString = DEFAULT_DATABASE_URL,
  ids = [],
} = {}) {
  // event_log.id is BIGSERIAL, so ids are kept as decimal strings and bound as
  // bigint[]. Narrowing them to JS numbers loses precision past 2^53, and an
  // int[] cast fails outright past 2^31 - both silently, on exactly the large
  // ids a long-lived log produces. src/postgres-executor.js validates the same
  // way for the same reason.
  //
  // Anything unusable is dropped rather than passed through: one malformed or
  // out-of-range id in the array would fail the cast and take every valid id
  // with it.
  const wanted = [
    ...new Set(ids.map(canonicalEventId).filter((id) => id !== null)),
  ];
  if (wanted.length === 0) return [];

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, ts, email, ip_address, method, path
         FROM event_log WHERE id = ANY($1::bigint[])`,
      [wanted],
    );
    // pg hands back a Date for a timestamptz. Everything downstream treats a
    // finding's row as plain JSON, so normalise here rather than teaching the
    // renderer about driver types.
    return rows.map((row) => ({
      ...row,
      ts: row.ts instanceof Date ? row.ts.toISOString() : row.ts,
    }));
  } finally {
    await client.end();
  }
}
