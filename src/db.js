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
    approval_id INTEGER NOT NULL REFERENCES approvals(id),
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
  const exists = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((item) => item.name === column);
  if (exists) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  return true;
};
addColumn('cases', 'revision INTEGER NOT NULL DEFAULT 0');
addColumn('cases', 'discovery_completed_at TEXT');
const plansMigrated = addColumn(
  'plans',
  'case_revision INTEGER NOT NULL DEFAULT 0',
);
const approvalsMigrated = addColumn(
  'approvals',
  'case_revision INTEGER NOT NULL DEFAULT -1',
);
const executionApprovalsMigrated = addColumn(
  'execution_runs',
  'approval_id INTEGER REFERENCES approvals(id)',
);
if (plansMigrated || approvalsMigrated) {
  db.exec(
    'UPDATE plans SET case_revision = -1; UPDATE approvals SET case_revision = -1;',
  );
}
if (executionApprovalsMigrated) {
  db.exec(`UPDATE execution_runs
    SET approval_id = (
      SELECT approvals.id FROM approvals
      JOIN cases ON cases.id = execution_runs.case_id
      WHERE approvals.case_id = execution_runs.case_id
        AND approvals.plan_hash = execution_runs.plan_hash
        AND approvals.case_revision = cases.revision
        AND approvals.approved_by = execution_runs.approved_by
      ORDER BY approvals.id DESC LIMIT 1
    )
    WHERE approval_id IS NULL`);
}

export const now = () => new Date().toISOString();
const parse = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
export const hydrate = (row) =>
  row &&
  Object.fromEntries(
    Object.entries(row).map(([k, v]) =>
      ['metadata', 'body', 'manifest', 'withheld'].includes(k)
        ? [k, parse(v)]
        : [k, v],
    ),
  );

export function getCase(caseId) {
  const result = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!result) return null;
  return {
    ...result,
    findings: db
      .prepare('SELECT * FROM findings WHERE case_id = ? ORDER BY id')
      .all(caseId)
      .map(hydrate),
    plans: db
      .prepare('SELECT * FROM plans WHERE case_id = ? ORDER BY version')
      .all(caseId)
      .map(hydrate),
    approvals: db
      .prepare('SELECT * FROM approvals WHERE case_id = ? ORDER BY id')
      .all(caseId),
    certificate: hydrate(
      db.prepare('SELECT * FROM certificates WHERE case_id = ?').get(caseId),
    ),
  };
}

export function listCases(status) {
  const query = status
    ? 'SELECT * FROM cases WHERE status = ? ORDER BY created_at DESC'
    : 'SELECT * FROM cases ORDER BY created_at DESC';
  return db
    .prepare(query)
    .all(...(status ? [status] : []))
    .map((item) => ({
      ...item,
      finding_count: db
        .prepare('SELECT count(*) AS count FROM findings WHERE case_id = ?')
        .get(item.id).count,
    }));
}

export function createCase({ id, subject_email, subject_name }) {
  const timestamp = now();
  db.prepare(
    'INSERT INTO cases (id, subject_email, subject_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, subject_email, subject_name ?? null, timestamp, timestamp);
  return getCase(id);
}

function mutableCase(caseId) {
  const subject = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!subject) throw new Error(`case not found: ${caseId}`);
  if (
    subject.status === 'completed' ||
    subject.status === 'executing' ||
    db.prepare('SELECT 1 FROM certificates WHERE case_id = ?').get(caseId)
  ) {
    throw new Error(
      subject.status === 'executing'
        ? 'case is executing and cannot be modified'
        : 'case is terminal and cannot be modified',
    );
  }
  return subject;
}

/**
 * Record types that survive erasure no matter who asks.
 *
 * A retained refund is a live financial obligation, deliberately detached from
 * the customer hierarchy so it outlives the account and orders it relates to.
 * Preserving it is the single claim this whole system exists to make.
 *
 * Until now that claim rested on the caller passing `disposition: 'retain'` -
 * a convention, safe only because the caller was a hardcoded script. Once an
 * agent chooses dispositions, a convention is not a guarantee, so the store
 * enforces it: whatever disposition arrives for one of these record types, the
 * finding is recorded as retained.
 */
export const ALWAYS_RETAIN_RECORD_TYPES = new Set(['retained_refund']);

export function retentionFor(recordType, requested) {
  return ALWAYS_RETAIN_RECORD_TYPES.has(recordType)
    ? 'retain'
    : (requested ?? 'erase');
}

function insertFindings(caseId, findings, timestamp) {
  const statement =
    db.prepare(`INSERT INTO findings (case_id, system, record_type, record_id, locator, metadata, disposition, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const finding of findings) {
    statement.run(
      caseId,
      finding.system,
      finding.record_type,
      String(finding.record_id),
      finding.locator ?? null,
      JSON.stringify(finding.metadata ?? {}),
      retentionFor(finding.record_type, finding.disposition),
      timestamp,
    );
  }
  // A finding change creates a new case revision, invalidates prior plans, and
  // undoes any prior discovery-complete mark since it is no longer accurate
  // for the case's current findings. One bump per call, not per finding: the
  // revision marks "the findings changed", and a batch is one such change.
  db.prepare(
    "UPDATE cases SET revision = revision + 1, status = 'discovered', discovery_completed_at = NULL, updated_at = ? WHERE id = ?",
  ).run(timestamp, caseId);
}

export function addFinding(caseId, finding) {
  const timestamp = now();
  db.transaction(() => {
    mutableCase(caseId);
    insertFindings(caseId, [finding], timestamp);
  })();
  return getCase(caseId).findings.at(-1);
}

/**
 * Record a whole result set in one call.
 *
 * Recording a real subject means several hundred findings - 400 event-log rows
 * alone for the seeded subject. One tool call per row is unremarkable for a
 * script and untenable for an agent, which will abandon the investigation
 * partway and summarise what it has instead. That failure is silent: a case
 * with a fraction of the findings still plans, still rehearses cleanly, and
 * still reads like a complete erasure.
 *
 * So the batch is the affordance that makes exhaustive discovery achievable,
 * not a convenience. Inserting in one transaction also means a batch either
 * lands whole or not at all, rather than leaving a case half-populated.
 */
export function addFindings(caseId, findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    throw new Error('findings must be a non-empty array');
  }
  const timestamp = now();
  db.transaction(() => {
    mutableCase(caseId);
    insertFindings(caseId, findings, timestamp);
  })();
  const subject = getCase(caseId);
  return {
    case_id: caseId,
    added: findings.length,
    finding_count: subject.findings.length,
    revision: subject.revision,
  };
}

// Discovery is a multi-step, fallible process (each MCP call can throw, e.g.
// on a truncated storage query) run entirely by the caller outside a
// transaction. plan_create must not trust a case's findings are complete just
// because some were successfully recorded, so completion is an explicit,
// separate signal the caller sends only after every discovery step succeeds.
export function completeDiscovery(caseId) {
  const timestamp = now();
  const transaction = db.transaction(() => {
    mutableCase(caseId);
    // A case with no findings describes nobody. Reached by a typo'd address, or
    // by an investigation that concluded before it searched anything, and in
    // both cases completing discovery would produce a plan that deletes
    // nothing and an approval prompt for a no-op. Refusing here is
    // system-agnostic on purpose: whether the subject is absent from Postgres,
    // from billing, or from everywhere is not one adapter's judgment to make.
    const { count } = db
      .prepare('SELECT count(*) AS count FROM findings WHERE case_id = ?')
      .get(caseId);
    if (count === 0) {
      throw new Error(
        `case ${caseId} has no findings; refusing to complete discovery for a subject with no discovered data`,
      );
    }
    db.prepare(
      'UPDATE cases SET discovery_completed_at = ?, updated_at = ? WHERE id = ?',
    ).run(timestamp, timestamp, caseId);
  });
  transaction();
  return getCase(caseId);
}

export function savePlan(caseId, body, planHash, expectedRevision) {
  const transaction = db.transaction(() => {
    const subject = mutableCase(caseId);
    if (
      !Number.isInteger(expectedRevision) ||
      expectedRevision !== subject.revision
    ) {
      throw new Error(
        'case changed while building plan; rebuild it from the current findings',
      );
    }
    const version = db
      .prepare(
        'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM plans WHERE case_id = ?',
      )
      .get(caseId).version;
    const timestamp = now();
    db.prepare(
      'INSERT INTO plans (case_id, version, body, plan_hash, case_revision, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      caseId,
      version,
      JSON.stringify(body),
      planHash,
      subject.revision,
      timestamp,
    );
    db.prepare(
      "UPDATE cases SET status = 'planned', updated_at = ? WHERE id = ?",
    ).run(timestamp, caseId);
    return hydrate(
      db
        .prepare('SELECT * FROM plans WHERE case_id = ? AND version = ?')
        .get(caseId, version),
    );
  });
  return transaction();
}

export function recordApproval(caseId, planHash, approvedBy, reason) {
  const transaction = db.transaction(() => {
    const subject = mutableCase(caseId);
    if (
      db
        .prepare(
          "SELECT 1 FROM execution_runs WHERE case_id = ? AND status = 'executing'",
        )
        .get(caseId)
    ) {
      throw new Error('case is executing and cannot be modified');
    }
    const plan = db
      .prepare('SELECT * FROM plans WHERE case_id = ? AND plan_hash = ?')
      .get(caseId, planHash);
    const latest = db
      .prepare(
        'SELECT * FROM plans WHERE case_id = ? ORDER BY version DESC LIMIT 1',
      )
      .get(caseId);
    if (!plan)
      throw new Error('plan hash does not match a stored plan for this case');
    if (
      !latest ||
      latest.id !== plan.id ||
      plan.case_revision !== subject.revision
    ) {
      throw new Error(
        'plan is stale; create a new plan for the current case revision',
      );
    }
    const timestamp = now();
    db.prepare(
      'INSERT INTO approvals (case_id, plan_hash, case_revision, approved_by, reason, approved_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      caseId,
      planHash,
      subject.revision,
      approvedBy,
      reason ?? null,
      timestamp,
    );
    db.prepare(
      "UPDATE cases SET status = 'approved', updated_at = ? WHERE id = ?",
    ).run(timestamp, caseId);
    return db
      .prepare(
        'SELECT * FROM approvals WHERE case_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(caseId);
  });
  return transaction();
}

export function close() {
  db.close();
}
process.once('exit', () => {
  if (db.open) db.close();
});
