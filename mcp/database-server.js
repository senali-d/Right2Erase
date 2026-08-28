#!/usr/bin/env node
/** Read-only ShopKart Postgres MCP adapter. No arbitrary SQL or mutation tools. */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { startHttpMcp } from './http-transport.js';
import {
  assertWithinSandbox, deleteSnapshot, rehearseDeletionPlan, resolveSandboxDir, sandboxSnapshotPath, writeSubjectSnapshot,
} from './snapshot.js';

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
// Bounds one db_stage_deletion_actions call's request size, not the logical
// size of a rehearsal: a caller stages an arbitrarily large discovered action
// set across as many chunked calls as it takes, each capped at this size, and
// db_rehearse_deletion_plan then runs one transactional rehearsal over
// everything staged. maxStagedActions is the only true ceiling on how large a
// single account's rehearsal can be.
const maxRehearsalChunkSize = positiveInteger(process.env.MCP_DB_MAX_REHEARSAL_CHUNK, 5000);
const maxStagedActions = positiveInteger(process.env.MCP_DB_MAX_STAGED_ACTIONS, 200000);

const sandboxDir = resolveSandboxDir();

function createServer() {
  const server = new McpServer({ name: 'shopkart-db', version: '1.0.0' });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  // Snapshot export never mutates ShopKart, but each call writes a fresh
  // sandbox file, so it is not idempotentHint like the pure query tools above.
  const sandboxWrite = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const tool = (name, description, inputSchema, handler, annotations = readOnly) => server.registerTool(name, {
    description, inputSchema, annotations,
  }, handler);

  // Maps opaque snapshot_id -> { path, actions }: the real sandbox path it
  // was exported to, and the delete actions staged for it so far via
  // db_stage_deletion_actions. db_rehearse_deletion_plan and db_delete_snapshot
  // accept only an id looked up here, never a path string from the caller, so
  // neither tool can ever be pointed at a file this process did not itself
  // just export - a symlink placed inside the sandbox directory has no id to
  // be reached through. Scoped to this session's server instance; ids from
  // one session are meaningless in another.
  const snapshots = new Map();

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
  tool('db_get_account_emails', `List current and historical email addresses for an account, one page of up to ${maxAccountEmails} rows at a time ordered by id. If truncated is true, call again with cursor set to next_cursor to fetch the next page; loop until truncated is false to see every address.`, {
    account_id: z.coerce.number().int().positive(), cursor: z.coerce.number().int().nonnegative().optional(),
  }, async ({ account_id, cursor }) => {
    const { rows } = await pool.query(
      'SELECT id, account_id, email, is_primary, valid_from, valid_until FROM account_emails WHERE account_id=$1 AND id > $2 ORDER BY id LIMIT $3',
      [account_id, cursor ?? 0, maxAccountEmails + 1],
    );
    const truncated = rows.length > maxAccountEmails;
    const page = truncated ? rows.slice(0, maxAccountEmails) : rows;
    return result({ rows: page, truncated, limit: maxAccountEmails, next_cursor: truncated ? page[page.length - 1].id : null });
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
  tool('db_export_subject_snapshot', `Export one account and every row reachable from it (historical emails, orders, order items, settled refunds, support tickets, uploads, event-log rows matched by known email/IP, and retained refunds referenced by its orders) into a self-contained sandbox SQLite snapshot. The snapshot enforces the same foreign-key dependencies as production PostgreSQL, so db_rehearse_deletion_plan can prove a deletion order safe before it ever touches real ShopKart data. Every call writes a fresh, uniquely named file, even for the same account, so concurrent exports never overwrite or delete each other. Returns snapshot_id: pass that opaque token, not snapshot_path, to db_stage_deletion_actions, db_rehearse_deletion_plan, and db_delete_snapshot - those tools accept only an id this server issued, never a path. A large discovered account's delete actions do not fit one db_stage_deletion_actions call (each is capped at ${maxRehearsalChunkSize}); call it repeatedly with successive chunks, in order, before calling db_rehearse_deletion_plan. Never call this with an ambiguous or unresolved account id.`, {
    account_id: z.coerce.number().int().positive(),
  }, async ({ account_id }) => {
    const accountResult = await pool.query(
      'SELECT id, email, full_name, country, last_seen_ip, created_at FROM accounts WHERE id=$1', [account_id],
    );
    const account = accountResult.rows[0];
    if (!account) throw new Error(`account not found: ${account_id}`);

    const [emails, orders] = await Promise.all([
      pool.query('SELECT id, account_id, email, is_primary, valid_from, valid_until FROM account_emails WHERE account_id=$1 ORDER BY id', [account_id]),
      pool.query('SELECT id, account_id, order_number, total_cents, status, ship_address, created_at FROM orders WHERE account_id=$1 ORDER BY id', [account_id]),
    ]);
    const orderIds = orders.rows.map((order) => order.id);
    const orderNumbers = orders.rows.map((order) => order.order_number);
    const knownEmails = [...new Set([account.email, ...emails.rows.map((row) => row.email)])];

    const [items, refunds, tickets, linkedUploads, orphanedUploads, events, retained] = await Promise.all([
      orderIds.length ? pool.query('SELECT id, order_id, sku, product_name, qty, price_cents FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY id', [orderIds]) : { rows: [] },
      orderIds.length ? pool.query("SELECT id, order_id, amount_cents, status, reason, opened_at, settled_at FROM refunds WHERE order_id = ANY($1::int[]) ORDER BY id", [orderIds]) : { rows: [] },
      pool.query('SELECT id, account_id, subject, body, status, created_at FROM support_tickets WHERE account_id=$1 ORDER BY id', [account_id]),
      pool.query('SELECT id, account_id, object_key, kind, bytes, created_at FROM uploads WHERE account_id=$1 ORDER BY id', [account_id]),
      // An upload row can have account_id NULL and no FK back to the account
      // at all - the only surviving link is the account's key prefix inside
      // the object path - so a plain account_id lookup misses it.
      pool.query('SELECT id, account_id, object_key, kind, bytes, created_at FROM uploads WHERE account_id IS NULL AND object_key LIKE $1 ORDER BY id', [`uploads/acct_${account_id}/%`]),
      pool.query(
        `SELECT id, ts, email, ip_address, method, path, status_code, user_agent FROM event_log
         WHERE email = ANY($1::text[]) OR ($2::inet IS NOT NULL AND ip_address=$2) ORDER BY ts, id`,
        [knownEmails, account.last_seen_ip || null],
      ),
      orderNumbers.length ? pool.query('SELECT id, source_order_number, amount_cents, reason, opened_at, retained_at FROM retained_refunds WHERE source_order_number = ANY($1::text[]) ORDER BY id', [orderNumbers]) : { rows: [] },
    ]);
    const uploads = { rows: [...linkedUploads.rows, ...orphanedUploads.rows] };

    const snapshotId = randomUUID();
    const dbPath = sandboxSnapshotPath(account_id, sandboxDir);
    const counts = writeSubjectSnapshot({
      dbPath,
      tables: {
        accounts: [account], account_emails: emails.rows, orders: orders.rows,
        order_items: items.rows, refunds: refunds.rows, support_tickets: tickets.rows,
        uploads: uploads.rows, event_log: events.rows, retained_refunds: retained.rows,
      },
    });
    snapshots.set(snapshotId, { path: dbPath, actions: [] });
    return result({ account_id, snapshot_id: snapshotId, snapshot_path: dbPath, counts });
  }, sandboxWrite);
  tool('db_stage_deletion_actions', `Append a chunk of planned delete actions (at most ${maxRehearsalChunkSize} per call) to a snapshot from db_export_subject_snapshot, addressed by snapshot_id. Call this once for a small discovered set, or repeatedly with successive chunks - in the exact order they belong in - to load a large one; each call only bounds its own request size, not the total staged, up to ${maxStagedActions} actions per snapshot. Nothing is rehearsed yet. Call db_rehearse_deletion_plan once every chunk has been staged to run one transactional rehearsal over the complete set.`, {
    snapshot_id: z.string().uuid(),
    actions: z.array(z.object({
      record_type: z.string().min(1),
      record_id: z.union([z.string(), z.number()]),
    })).min(1).max(maxRehearsalChunkSize),
  }, async ({ snapshot_id, actions }) => {
    const snapshot = snapshots.get(snapshot_id);
    if (!snapshot) throw new Error(`unknown snapshot_id: ${snapshot_id}`);
    if (snapshot.actions.length + actions.length > maxStagedActions) {
      throw new Error(`staging ${actions.length} more action(s) would exceed the ${maxStagedActions}-action limit for this snapshot (${snapshot.actions.length} already staged)`);
    }
    snapshot.actions.push(...actions);
    return result({ snapshot_id, staged_count: snapshot.actions.length });
  }, sandboxWrite);
  tool('db_rehearse_deletion_plan', 'Rehearse every action staged for a snapshot via db_stage_deletion_actions (call that one or more times first - this tool takes no actions itself, so there is no cap on how large a rehearsal it can run). Runs inside a transaction that is always rolled back, so rehearsal never mutates the snapshot and never touches real ShopKart data. If the staged order hits a foreign-key violation (for example deleting an order before its order_items) and auto_order is not set to false, a second attempt is made in the known leaf-to-root order and both attempts are returned. Consumes everything staged for this snapshot_id, whether the rehearsal succeeds or fails; re-stage before rehearsing again. Call this after plan_create and before requesting human approval; do not request approval for a plan that fails rehearsal.', {
    snapshot_id: z.string().uuid(),
    auto_order: z.boolean().optional(),
  }, async ({ snapshot_id, auto_order }) => {
    const snapshot = snapshots.get(snapshot_id);
    if (!snapshot) throw new Error(`unknown snapshot_id: ${snapshot_id}`);
    const resolved = assertWithinSandbox(snapshot.path, sandboxDir);
    const outcome = rehearseDeletionPlan({ dbPath: resolved, actions: snapshot.actions, autoOrder: auto_order !== false });
    snapshot.actions = [];
    return result(outcome);
  });
  tool('db_delete_snapshot', 'Delete a sandbox snapshot previously written by db_export_subject_snapshot, addressed by the snapshot_id that call returned - not a path. Call this once rehearsal for that account is finished (whether it passed or failed) so the exported PII copy does not outlive the rehearsal that needed it. A no-op if the id is unknown or was already deleted.', {
    snapshot_id: z.string().uuid(),
  }, async ({ snapshot_id }) => {
    const snapshot = snapshots.get(snapshot_id);
    if (!snapshot) return result({ snapshot_id, deleted: false });
    const resolved = assertWithinSandbox(snapshot.path, sandboxDir);
    deleteSnapshot(resolved);
    snapshots.delete(snapshot_id);
    return result({ snapshot_id, deleted: true });
  }, sandboxWrite);
  return server;
}

if (process.env.MCP_TRANSPORT === 'http') {
  startHttpMcp(createServer, { name: 'shopkart-db', port: Number(process.env.MCP_DB_PORT || process.env.MCP_PORT || 4012) });
} else {
  await createServer().connect(new StdioServerTransport());
}
process.once('SIGINT', () => pool.end());
process.once('SIGTERM', () => pool.end());
