/**
 * The destructive PostgreSQL adapter for the ShopKart sandbox.
 *
 * This module is intentionally not part of the read-only database MCP.  The
 * orchestrator supplies an approved, closed plan; this adapter never searches
 * for records and never derives additional targets from a parent record.
 */
import pg from 'pg';

const { Pool } = pg;

// The order is part of the fixture's safety contract (leaf -> root).
const TABLES = [
  ['order_items', 'int[]'],
  ['refunds', 'int[]'],
  ['orders', 'int[]'],
  ['support_tickets', 'int[]'],
  ['uploads', 'int[]'],
  ['account_emails', 'int[]'],
  ['event_log', 'bigint[]'],
  ['accounts', 'int[]'],
];
const TABLE_ALIASES = new Map([
  ['order_item', 'order_items'], ['order_items', 'order_items'],
  ['refund', 'refunds'], ['refunds', 'refunds'],
  ['order', 'orders'], ['orders', 'orders'],
  ['support_ticket', 'support_tickets'], ['support_tickets', 'support_tickets'],
  ['upload', 'uploads'], ['uploads', 'uploads'],
  ['account_email', 'account_emails'], ['account_emails', 'account_emails'],
  ['event', 'event_log'], ['event_log', 'event_log'],
  ['account', 'accounts'], ['accounts', 'accounts'],
  ['retained_refund', 'retained_refunds'], ['retained_refunds', 'retained_refunds'],
]);

function normalizePlan(plan) {
  if (!plan || !Array.isArray(plan.actions)) throw new Error('plan.actions must be an array');
  const withheld = Array.isArray(plan.withhold) ? plan.withhold : [];
  const blocked = new Set(withheld.map((r) => `${r?.table}:${String(r?.id)}`));
  const targets = new Map(TABLES.map(([table]) => [table, []]));
  const seen = new Set();

  for (const action of plan.actions) {
    if (!action) throw new Error('plan action must be an object');
    const system = action.system == null ? null : String(action.system).toLowerCase();
    if (system && !['postgres', 'postgresql', 'database', 'db'].includes(system)) continue;
    if (action.disposition === 'retain' || action.disposition === 'review') continue;
    if (action.disposition != null && action.disposition !== 'erase') {
      throw new Error(`unsupported action disposition: ${action.disposition}`);
    }
    const table = TABLE_ALIASES.get(action.record_type);
    if (!table) throw new Error(`unsupported PostgreSQL record type: ${action.record_type}`);
    // Retained refunds are deliberately not in TABLES. They are obligations,
    // not erasure targets, even if a caller accidentally includes one.
    if (table === 'retained_refunds') continue;
    const id = String(action.record_id);
    if (!/^\d+$/.test(id) || BigInt(id) <= 0n) throw new Error(`invalid ${table} record id: ${id}`);
    const key = `${table}:${id}`;
    if (blocked.has(key)) throw new Error(`withheld record is not deletable: ${key}`);
    if (seen.has(key)) throw new Error(`duplicate planned record: ${key}`);
    seen.add(key);
    targets.get(table).push(id);
  }
  return targets;
}

function sandboxGuard(connectionString) {
  if (process.env.NODE_ENV === 'production') throw new Error('PostgreSQL deletion executor is sandbox-only');
  const url = new URL(connectionString);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (!local || (url.pathname && url.pathname !== '/shopkart')) {
    throw new Error('refusing non-local or non-ShopKart PostgreSQL target');
  }
}

/**
 * Create an executor. Inject a Pool in tests/orchestrators, or let the adapter
 * create a pool from POSTGRES_SANDBOX_DATABASE_URL/DATABASE_URL.
 */
export function createPostgresExecutor({ pool, connectionString } = {}) {
  let ownedPool = pool;
  if (!ownedPool) {
    const url = connectionString || process.env.POSTGRES_SANDBOX_DATABASE_URL
      || process.env.DATABASE_URL || 'postgres://shopkart:shopkart@localhost:5432/shopkart';
    sandboxGuard(url);
    ownedPool = new Pool({ connectionString: url, max: 1 });
  }

  return {
    async execute(plan) {
      const targets = normalizePlan(plan);
      const client = await ownedPool.connect();
      const counts = {};
      try {
        await client.query('BEGIN');
        for (const [table, cast] of TABLES) {
          const ids = targets.get(table);
          if (!ids.length) continue;
          // The table and cast come exclusively from the constants above.
          const condition = table === 'refunds' ? 'id = ANY($1::int[]) AND status = \'settled\'' : 'id = ANY($1::' + cast + ')';
          const result = await client.query(`DELETE FROM ${table} WHERE ${condition} RETURNING id`, [ids]);
          if (table === 'refunds' && result.rowCount !== ids.length) {
            throw new Error('refusing to delete a non-settled refund');
          }
          if (result.rowCount !== ids.length) {
            throw new Error(`planned ${table} record is missing`);
          }
          counts[table] = result.rowCount;
        }
        await client.query('COMMIT');
        return counts;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      if (ownedPool && typeof ownedPool.end === 'function' && !pool) await ownedPool.end();
    },
  };
}

// A small interface-shaped convenience for orchestrators that do not need to
// retain an executor instance.
export async function executePostgresDeletion(plan, options) {
  const executor = createPostgresExecutor(options);
  try { return await executor.execute(plan); } finally { await executor.close(); }
}

export { normalizePlan };
