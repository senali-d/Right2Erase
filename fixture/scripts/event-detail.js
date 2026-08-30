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
  const wanted = ids
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (wanted.length === 0) return [];

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, ts, email, ip_address, method, path
         FROM event_log WHERE id = ANY($1::int[])`,
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
