/**
 * Sandbox snapshot + rehearsal support for the ShopKart Postgres MCP adapter.
 *
 * db_export_subject_snapshot copies one account's reachable rows into a
 * throwaway SQLite file that mirrors fixture/db/schema.sql's foreign keys.
 * db_rehearse_deletion_plan then tries a caller-supplied delete order against
 * that file inside a transaction it always rolls back, so a plan can be
 * proven safe (or caught mid-mistake, e.g. deleting an order before its
 * order_items) without ever touching the real ShopKart database.
 *
 * This module has no import relationship with src/postgres-executor.js - the
 * two are separate services in this architecture - so the leaf-to-root
 * dependency order below is intentionally kept in sync with, not imported
 * from, that adapter's TABLES constant.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_SQL = `
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  country TEXT NOT NULL,
  last_seen_ip TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE account_emails (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  email TEXT NOT NULL,
  is_primary INTEGER NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  order_number TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  ship_address TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  sku TEXT NOT NULL,
  product_name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price_cents INTEGER NOT NULL
);
CREATE TABLE refunds (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  settled_at TEXT NOT NULL
);
CREATE TABLE support_tickets (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE uploads (
  id INTEGER PRIMARY KEY,
  account_id INTEGER REFERENCES accounts(id),
  object_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE event_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  email TEXT,
  ip_address TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  user_agent TEXT NOT NULL
);
CREATE TABLE retained_refunds (
  id INTEGER PRIMARY KEY,
  source_order_number TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  retained_at TEXT NOT NULL
);
`;

// Parents before children, matching the schema's foreign keys.
const TABLE_COLUMNS = new Map([
  ['accounts', ['id', 'email', 'full_name', 'country', 'last_seen_ip', 'created_at']],
  ['account_emails', ['id', 'account_id', 'email', 'is_primary', 'valid_from', 'valid_until']],
  ['orders', ['id', 'account_id', 'order_number', 'total_cents', 'status', 'ship_address', 'created_at']],
  ['order_items', ['id', 'order_id', 'sku', 'product_name', 'qty', 'price_cents']],
  ['refunds', ['id', 'order_id', 'amount_cents', 'status', 'reason', 'opened_at', 'settled_at']],
  ['support_tickets', ['id', 'account_id', 'subject', 'body', 'status', 'created_at']],
  ['uploads', ['id', 'account_id', 'object_key', 'kind', 'bytes', 'created_at']],
  ['event_log', ['id', 'ts', 'email', 'ip_address', 'method', 'path', 'status_code', 'user_agent']],
  ['retained_refunds', ['id', 'source_order_number', 'amount_cents', 'reason', 'opened_at', 'retained_at']],
]);

// The same leaf -> root delete order as src/postgres-executor.js's TABLES.
export const CANONICAL_DELETE_ORDER = [
  'order_items', 'refunds', 'orders', 'support_tickets', 'uploads', 'account_emails', 'event_log', 'accounts',
];

const RECORD_TYPE_TO_TABLE = new Map([
  ['order_item', 'order_items'], ['order_items', 'order_items'],
  ['refund', 'refunds'], ['refunds', 'refunds'],
  ['order', 'orders'], ['orders', 'orders'],
  ['support_ticket', 'support_tickets'], ['support_tickets', 'support_tickets'],
  ['upload', 'uploads'], ['uploads', 'uploads'],
  ['account_email', 'account_emails'], ['account_emails', 'account_emails'],
  ['event', 'event_log'], ['event_log', 'event_log'],
  ['account', 'accounts'], ['accounts', 'accounts'],
]);

export function normalizeSnapshotTable(recordType) {
  if (typeof recordType !== 'string') return null;
  return RECORD_TYPE_TO_TABLE.get(recordType.toLowerCase()) || null;
}

export function resolveSandboxDir(sandboxDir = process.env.OUBLIETTE_SANDBOX_DIR || '.oubliette/sandbox') {
  return path.resolve(sandboxDir);
}

export function sandboxSnapshotPath(accountId, sandboxDir = resolveSandboxDir()) {
  return path.join(resolveSandboxDir(sandboxDir), `account-${accountId}.db`);
}

/** Throws unless filePath resolves inside sandboxDir. Guards db_rehearse_deletion_plan against being pointed at an arbitrary file. */
export function assertWithinSandbox(filePath, sandboxDir = resolveSandboxDir()) {
  const resolved = path.resolve(filePath);
  const base = resolveSandboxDir(sandboxDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('snapshot path is outside the sandbox directory');
  }
  return resolved;
}

function coerce(value) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function insertRows(db, table, rows) {
  if (!rows.length) return 0;
  const columns = TABLE_COLUMNS.get(table);
  const stmt = db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  db.transaction((items) => {
    for (const row of items) stmt.run(...columns.map((column) => coerce(row[column])));
  })(rows);
  return rows.length;
}

/**
 * Write a fresh, self-contained sandbox snapshot. tables maps table name to
 * an array of plain row objects (as returned by the pg driver); any table
 * omitted is treated as empty. Always overwrites dbPath.
 */
export function writeSubjectSnapshot({ dbPath, tables }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    const counts = {};
    for (const table of TABLE_COLUMNS.keys()) counts[table] = insertRows(db, table, tables[table] || []);
    return counts;
  } finally {
    db.close();
  }
}

/** Try one delete order against the snapshot inside a transaction that is always rolled back. */
function attemptDeleteOrder(dbPath, actions) {
  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = ON');
    let completed = 0;
    db.exec('BEGIN');
    try {
      for (const action of actions) {
        const table = normalizeSnapshotTable(action.record_type);
        if (!table) throw new Error(`unsupported record type for rehearsal: ${action.record_type}`);
        const id = String(action.record_id);
        if (!/^\d+$/.test(id)) throw new Error(`invalid record id for rehearsal: ${id}`);
        const outcome = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
        if (outcome.changes !== 1) throw new Error(`record not found in snapshot: ${table}:${id}`);
        completed += 1;
      }
      return { ok: true, steps: actions.length };
    } catch (error) {
      return {
        ok: false,
        completed_steps: completed,
        failed_action: actions[completed] ? { ...actions[completed] } : null,
        error: error.message,
      };
    } finally {
      // Rehearsal never keeps its deletes - the snapshot must stay reusable
      // for the next attempt, and no attempt may ever be the real deletion.
      db.exec('ROLLBACK');
    }
  } finally {
    db.close();
  }
}

/**
 * Rehearse a plan's delete actions in the order given. If that order fails
 * and autoOrder is true (the default), retry once in the known leaf-to-root
 * order so a plan whose actions merely aren't sorted yet can still pass.
 */
export function rehearseDeletionPlan({ dbPath, actions, autoOrder = true }) {
  const attempts = [];
  const asPlanned = attemptDeleteOrder(dbPath, actions);
  attempts.push({ order: 'as_planned', ...asPlanned });
  if (asPlanned.ok || !autoOrder) return { ok: asPlanned.ok, attempts };

  const canonical = [...actions].sort((a, b) => CANONICAL_DELETE_ORDER.indexOf(normalizeSnapshotTable(a.record_type))
    - CANONICAL_DELETE_ORDER.indexOf(normalizeSnapshotTable(b.record_type)));
  const reordered = attemptDeleteOrder(dbPath, canonical);
  attempts.push({ order: 'canonical_leaf_to_root', ...reordered });
  return { ok: reordered.ok, attempts };
}
