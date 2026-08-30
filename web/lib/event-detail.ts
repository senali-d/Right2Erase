import {
  canonicalEventId,
  fetchEventRows,
} from '../../fixture/scripts/event-detail.js';
import type { CaseRecord, Finding } from './mcp';

/**
 * Fill in the event-log rows behind event findings, for display only.
 *
 * An event finding stores nothing but its id. That is deliberate: a subject
 * routinely has hundreds of log entries, and db_search_event_log returns ids
 * rather than rows precisely so an investigation is not buried in payload it
 * does not need. The cost is that the one trap the log exists to demonstrate -
 * the identity chain, where months of history sit under an address the subject
 * no longer uses - showed in the UI as "entry 6".
 *
 * So the rows are read here, on the server, at render time. This is a read for
 * a human looking at a page: it adds nothing to any tool, changes no finding,
 * and takes the same route the verification panel already uses.
 *
 * After execution the rows are gone, which is the erasure having worked. Those
 * findings keep their id-only label.
 */

/** Enough to name every row a panel will show, without reading a whole log. */
const MAX_LOOKUP = 200;

/**
 * event_log.id is BIGSERIAL, and node-postgres hands bigint back as a string
 * rather than risk a lossy Number. Ids stay strings the whole way through -
 * matched as strings, keyed as strings - so a large id is never rounded on its
 * way to becoming a map key it no longer matches.
 */
type EventRow = { id: string | number };

export async function withEventDetail(record: CaseRecord): Promise<CaseRecord> {
  const findings = record.findings ?? [];
  // Canonicalised before the cap, so an unusable id cannot consume one of the
  // slots a real one needed.
  const ids = findings
    .filter((f) => f.record_type === 'event')
    .map((f) => canonicalEventId(f.record_id))
    .filter((id): id is string => id !== null)
    .slice(0, MAX_LOOKUP);
  if (ids.length === 0) return record;

  let rows: EventRow[] = [];
  try {
    rows = (await fetchEventRows({
      connectionString: process.env.DATABASE_URL,
      ids,
    })) as EventRow[];
  } catch {
    // Display detail is not worth failing a case view over. Without it the
    // findings render by id, exactly as they did before.
    return record;
  }

  // Both sides keyed through the same normaliser. PostgreSQL answers with the
  // canonical spelling of an id, so a finding recorded as "007" would never
  // match a row returned as 7 if either side keyed on its raw string.
  const byId = new Map(
    rows.map((row) => [canonicalEventId(row.id) ?? String(row.id), row]),
  );
  return {
    ...record,
    findings: findings.map((finding: Finding) => {
      if (finding.record_type !== 'event') return finding;
      const key = canonicalEventId(finding.record_id);
      const row = key ? byId.get(key) : undefined;
      return row ? { ...finding, metadata: { row } } : finding;
    }),
  };
}
