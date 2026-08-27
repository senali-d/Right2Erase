import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const databasePath = process.env.OUBLIETTE_DB_PATH || '.oubliette/oubliette.db';
fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });

export const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    subject_email TEXT NOT NULL,
    subject_name TEXT,
    status TEXT NOT NULL DEFAULT 'discovered'
      CHECK (status IN ('discovered','planned','approved','executing','completed','failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    system TEXT NOT NULL,
    record_type TEXT NOT NULL,
    record_id TEXT NOT NULL,
    locator TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    disposition TEXT NOT NULL DEFAULT 'erase'
      CHECK (disposition IN ('erase','retain','review')),
    created_at TEXT NOT NULL,
    UNIQUE(case_id, system, record_type, record_id)
  );
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    body TEXT NOT NULL,
    plan_hash TEXT NOT NULL,
    case_revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(case_id, version), UNIQUE(plan_hash)
  );
  CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    plan_hash TEXT NOT NULL,
    case_revision INTEGER NOT NULL,
    approved_by TEXT NOT NULL,
    reason TEXT,
    approved_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS certificates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL UNIQUE REFERENCES cases(id),
    plan_hash TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    manifest TEXT NOT NULL,
    withheld TEXT NOT NULL DEFAULT '[]',
    executed_at TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS certificates_immutable_update
    BEFORE UPDATE ON certificates BEGIN SELECT RAISE(ABORT, 'certificates are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS certificates_immutable_delete
    BEFORE DELETE ON certificates BEGIN SELECT RAISE(ABORT, 'certificates are immutable'); END;
  CREATE TABLE IF NOT EXISTS execution_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    plan_hash TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('executing','failed','completed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(case_id, plan_hash)
  );
  CREATE TABLE IF NOT EXISTS execution_phases (
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    plan_hash TEXT NOT NULL,
    system TEXT NOT NULL,
    result TEXT NOT NULL,
    manifest TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    PRIMARY KEY (case_id, plan_hash, system)
  );
  CREATE TABLE IF NOT EXISTS billing_progress (
    case_id TEXT NOT NULL,
    plan_hash TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('deleted','failed')),
    result TEXT,
    error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (case_id, plan_hash, customer_id)
  );
  CREATE TABLE IF NOT EXISTS billing_transactions (
    case_id TEXT NOT NULL,
    plan_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status = 'committed'),
    result TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (case_id, plan_hash)
  );
`);

// Keep databases created before revision tracking readable. Existing plans and
// approvals are deliberately marked stale rather than silently trusted.
const addColumn = (table, definition) => {
  const column = definition.split(' ')[0];
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
  if (exists) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  return true;
};
addColumn('cases', 'revision INTEGER NOT NULL DEFAULT 0');
const plansMigrated = addColumn('plans', 'case_revision INTEGER NOT NULL DEFAULT 0');
const approvalsMigrated = addColumn('approvals', 'case_revision INTEGER NOT NULL DEFAULT -1');
if (plansMigrated || approvalsMigrated) {
  db.exec('UPDATE plans SET case_revision = -1; UPDATE approvals SET case_revision = -1;');
}

export const now = () => new Date().toISOString();
const parse = (value) => {
  try { return JSON.parse(value); } catch { return value; }
};
export const hydrate = (row) => row && Object.fromEntries(Object.entries(row).map(([k, v]) =>
  ['metadata', 'body', 'manifest', 'withheld'].includes(k) ? [k, parse(v)] : [k, v]));

export function getCase(caseId) {
  const result = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!result) return null;
  return {
    ...result,
    findings: db.prepare('SELECT * FROM findings WHERE case_id = ? ORDER BY id').all(caseId).map(hydrate),
    plans: db.prepare('SELECT * FROM plans WHERE case_id = ? ORDER BY version').all(caseId).map(hydrate),
    approvals: db.prepare('SELECT * FROM approvals WHERE case_id = ? ORDER BY id').all(caseId),
    certificate: hydrate(db.prepare('SELECT * FROM certificates WHERE case_id = ?').get(caseId)),
  };
}

export function listCases(status) {
  const query = status ? 'SELECT * FROM cases WHERE status = ? ORDER BY created_at DESC' : 'SELECT * FROM cases ORDER BY created_at DESC';
  return db.prepare(query).all(...(status ? [status] : [])).map((item) => ({ ...item, finding_count: db.prepare('SELECT count(*) AS count FROM findings WHERE case_id = ?').get(item.id).count }));
}

export function createCase({ id, subject_email, subject_name }) {
  const timestamp = now();
  db.prepare('INSERT INTO cases (id, subject_email, subject_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, subject_email, subject_name ?? null, timestamp, timestamp);
  return getCase(id);
}

function mutableCase(caseId) {
  const subject = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!subject) throw new Error(`case not found: ${caseId}`);
  if (subject.status === 'completed' || subject.status === 'executing' || db.prepare('SELECT 1 FROM certificates WHERE case_id = ?').get(caseId)) {
    throw new Error(subject.status === 'executing'
      ? 'case is executing and cannot be modified'
      : 'case is terminal and cannot be modified');
  }
  return subject;
}

export function addFinding(caseId, finding) {
  const timestamp = now();
  const transaction = db.transaction(() => {
    mutableCase(caseId);
    db.prepare(`INSERT INTO findings (case_id, system, record_type, record_id, locator, metadata, disposition, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(caseId, finding.system, finding.record_type, String(finding.record_id), finding.locator ?? null,
        JSON.stringify(finding.metadata ?? {}), finding.disposition ?? 'erase', timestamp);
    // A finding change creates a new case revision and invalidates prior plans.
    db.prepare("UPDATE cases SET revision = revision + 1, status = 'discovered', updated_at = ? WHERE id = ?").run(timestamp, caseId);
  });
  transaction();
  return getCase(caseId).findings.at(-1);
}

export function savePlan(caseId, body, planHash, expectedRevision) {
  const transaction = db.transaction(() => {
    const subject = mutableCase(caseId);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== subject.revision) {
      throw new Error('case changed while building plan; rebuild it from the current findings');
    }
    const version = db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM plans WHERE case_id = ?').get(caseId).version;
    const timestamp = now();
    db.prepare('INSERT INTO plans (case_id, version, body, plan_hash, case_revision, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(caseId, version, JSON.stringify(body), planHash, subject.revision, timestamp);
    db.prepare("UPDATE cases SET status = 'planned', updated_at = ? WHERE id = ?").run(timestamp, caseId);
    return hydrate(db.prepare('SELECT * FROM plans WHERE case_id = ? AND version = ?').get(caseId, version));
  });
  return transaction();
}

export function recordApproval(caseId, planHash, approvedBy, reason) {
  const transaction = db.transaction(() => {
    const subject = mutableCase(caseId);
    const plan = db.prepare('SELECT * FROM plans WHERE case_id = ? AND plan_hash = ?').get(caseId, planHash);
    const latest = db.prepare('SELECT * FROM plans WHERE case_id = ? ORDER BY version DESC LIMIT 1').get(caseId);
    if (!plan) throw new Error('plan hash does not match a stored plan for this case');
    if (!latest || latest.id !== plan.id || plan.case_revision !== subject.revision) {
      throw new Error('plan is stale; create a new plan for the current case revision');
    }
    const timestamp = now();
    db.prepare('INSERT INTO approvals (case_id, plan_hash, case_revision, approved_by, reason, approved_at) VALUES (?, ?, ?, ?, ?, ?)').run(caseId, planHash, subject.revision, approvedBy, reason ?? null, timestamp);
    db.prepare("UPDATE cases SET status = 'approved', updated_at = ? WHERE id = ?").run(timestamp, caseId);
    return db.prepare('SELECT * FROM approvals WHERE case_id = ? ORDER BY id DESC LIMIT 1').get(caseId);
  });
  return transaction();
}

export function close() { db.close(); }
process.once('exit', () => { if (db.open) db.close(); });
