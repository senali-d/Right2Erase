#!/usr/bin/env node
/** Read-only ShopKart Postgres MCP adapter. No arbitrary SQL or mutation tools. */
import pg from 'pg';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { startHttpMcp } from './http-transport.js';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://shopkart:shopkart@localhost:5432/shopkart',
  max: 4,
});
const result = (rows) => ({ content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] });
const ids = z.array(z.coerce.number().int().positive()).min(1).max(500);
const escapeLike = (value) => value.replace(/[\\%_]/g, '\\$&');

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
// account_emails has no schema-level cap on historical addresses per account,
// unlike db_search_event_log's 100-email input limit. Without a query-side
// bound here, a caller partitioning the full list into event-log batches has
// no upper limit on how many batches it ends up issuing.
const maxAccountEmails = positiveInteger(process.env.MCP_DB_MAX_ACCOUNT_EMAILS || process.env.MCP_MAX_RESULTS, 500);

function createServer() {
  const server = new McpServer({ name: 'shopkart-db', version: '1.0.0' });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const tool = (name, description, inputSchema, handler) => server.registerTool(name, {
    description, inputSchema, annotations: readOnly,
  }, handler);

  tool('db_find_accounts', 'Find accounts by exact email (current or historical) or exact display name. Never use name alone to select a deletion target. account_emails has no cross-account uniqueness constraint, so a historical address can resolve to more than one account; check matched_via on every row and treat multiple distinct accounts as a collision to resolve manually, not a set of deletion targets.', {
    email: z.string().email().optional(), full_name: z.string().min(1).max(200).optional(),
  }, async ({ email, full_name }) => {
    if (!email && !full_name) throw new Error('email or full_name is required');
    const { rows } = await pool.query(
      `SELECT a.id, a.email, a.full_name, a.country, a.last_seen_ip, a.created_at,
              CASE
                WHEN $1::text IS NOT NULL AND a.email = $1 THEN 'current_email'
                WHEN $1::text IS NOT NULL AND EXISTS (
                  SELECT 1 FROM account_emails ae WHERE ae.account_id = a.id AND ae.email = $1
                ) THEN 'historical_email'
                ELSE 'full_name'
              END AS matched_via
       FROM accounts a
       WHERE ($1::text IS NOT NULL AND (a.email = $1 OR EXISTS (
               SELECT 1 FROM account_emails ae WHERE ae.account_id = a.id AND ae.email = $1
             )))
          OR ($2::text IS NOT NULL AND a.full_name = $2)
       ORDER BY id`, [email ?? null, full_name ?? null],
    );
    return result(rows);
  });
  tool('db_get_account_emails', `List current and historical email addresses for an account. Truncates at ${maxAccountEmails} rows; check the truncated flag before batching these into further per-email queries.`, { account_id: z.coerce.number().int().positive() }, async ({ account_id }) => {
    const { rows } = await pool.query('SELECT id, account_id, email, is_primary, valid_from, valid_until FROM account_emails WHERE account_id=$1 ORDER BY valid_from LIMIT $2', [account_id, maxAccountEmails + 1]);
    const truncated = rows.length > maxAccountEmails;
    return result({ rows: truncated ? rows.slice(0, maxAccountEmails) : rows, truncated, limit: maxAccountEmails });
  });
  tool('db_list_orders', 'List all orders belonging to one account.', { account_id: z.coerce.number().int().positive() }, async ({ account_id }) => {
    const { rows } = await pool.query('SELECT id, account_id, order_number, total_cents, status, ship_address, created_at FROM orders WHERE account_id=$1 ORDER BY id', [account_id]);
    return result(rows);
  });
  tool('db_list_order_items', 'List order items for the supplied order ids.', { order_ids: ids }, async ({ order_ids }) => {
    const { rows } = await pool.query('SELECT id, order_id, sku, product_name, qty, price_cents FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY order_id, id', [order_ids]);
    return result(rows);
  });
  tool('db_list_refunds', 'List settled refunds for the supplied order ids.', { order_ids: ids }, async ({ order_ids }) => {
    const { rows } = await pool.query("SELECT id, order_id, amount_cents, status, reason, opened_at, settled_at FROM refunds WHERE order_id = ANY($1::int[]) ORDER BY order_id, id", [order_ids]);
    return result(rows);
  });
  tool('db_list_retained_refunds', 'List retained financial obligations by source order number. These must not be deleted.', { order_numbers: z.array(z.string().min(1).max(50)).min(1).max(500) }, async ({ order_numbers }) => {
    const { rows } = await pool.query('SELECT id, source_order_number, amount_cents, reason, opened_at, retained_at FROM retained_refunds WHERE source_order_number = ANY($1::text[]) ORDER BY id', [order_numbers]);
    return result(rows);
  });
  tool('db_list_support_tickets', 'List support tickets for an account.', { account_id: z.coerce.number().int().positive() }, async ({ account_id }) => {
    const { rows } = await pool.query('SELECT id, account_id, subject, body, status, created_at FROM support_tickets WHERE account_id=$1 ORDER BY id', [account_id]);
    return result(rows);
  });
  tool('db_search_uploads', 'Find upload index records by account id or object-key prefix, including orphaned records.', {
    account_id: z.coerce.number().int().positive().optional(), object_prefix: z.string().min(1).max(300).optional(),
  }, async ({ account_id, object_prefix }) => {
    if (account_id == null && !object_prefix) throw new Error('account_id or object_prefix is required');
    const escapedPrefix = object_prefix ? escapeLike(object_prefix) : null;
    const { rows } = await pool.query(
      `SELECT id, account_id, object_key, kind, bytes, created_at FROM uploads
       WHERE ($1::int IS NOT NULL AND account_id=$1) OR ($2::text IS NOT NULL AND object_key LIKE $2 || '%' ESCAPE '\\') ORDER BY id`,
      [account_id ?? null, escapedPrefix],
    );
    return result(rows);
  });
  tool('db_search_event_log', 'Search request logs by any known email address and/or IP address.', {
    emails: z.array(z.string().email()).max(100).optional(), ip_address: z.string().ip().optional(),
  }, async ({ emails, ip_address }) => {
    if ((!emails || emails.length === 0) && !ip_address) throw new Error('emails or ip_address is required');
    const { rows } = await pool.query(
      `SELECT id, ts, email, ip_address, method, path, status_code, user_agent FROM event_log
       WHERE ($1::text[] IS NOT NULL AND email = ANY($1::text[])) OR ($2::inet IS NOT NULL AND ip_address=$2) ORDER BY ts, id`,
      [emails?.length ? emails : null, ip_address ?? null],
    );
    return result(rows);
  });
  return server;
}

if (process.env.MCP_TRANSPORT === 'http') {
  startHttpMcp(createServer, { name: 'shopkart-db', port: Number(process.env.MCP_DB_PORT || process.env.MCP_PORT || 4012) });
} else {
  await createServer().connect(new StdioServerTransport());
}
process.once('SIGINT', () => pool.end());
process.once('SIGTERM', () => pool.end());
