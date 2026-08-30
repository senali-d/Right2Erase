import type { CaseRecord, Finding, PlanAction } from './mcp';
import type { Phase } from './phases';

/**
 * Turns a case_get response into everything the control center renders.
 *
 * Pure and synchronous on purpose - every number on screen is derived from the
 * findings and the stored plan, so there is nothing to keep in sync and no way
 * for the UI to disagree with what Oubliette will actually execute.
 */

export type StepState = 'pending' | 'active' | 'done' | 'failed';

export type SystemKey = 'postgres' | 'minio' | 'billing' | 'identity';

export type RecordItem = {
  record_id: string;
  label: string;
};

export type RecordGroup = {
  /** Which system holds these. Only worth showing where a view spans several. */
  system: string;
  record_type: string;
  count: number;
  /** A sample, not the whole set - see ITEMS_PER_GROUP. */
  items: RecordItem[];
  /** How many of `count` are not in `items`. */
  hidden: number;
  /** Why this record type is treated differently, where that is not obvious. */
  note?: string;
};

export type SystemCard = {
  key: SystemKey;
  label: string;
  unit: string;
  count: number;
  /**
   * The records behind the count, grouped by kind.
   *
   * A count alone is not something a human can approve. "14 records" tells an
   * operator nothing about whether the right 14 were found, and the one panel
   * that has always been convincing - the withheld refund - is convincing
   * precisely because it names the record instead of counting it.
   */
  groups: RecordGroup[];
};

export type WithheldRecord = {
  system: string;
  record_type: string;
  record_id: string;
  disposition: string;
  order_number?: string;
  amount_cents?: number;
  reason?: string;
};

export type CaseView = {
  case_id: string;
  subject_email: string;
  subject_name: string | null;
  status: CaseRecord['status'];
  created_at: string;
  updated_at: string;
  revision: number;
  discovery_complete: boolean;
  systems: SystemCard[];
  totals: { findings: number; erase: number; withheld: number };
  withheld: WithheldRecord[];
  plan: {
    version: number;
    plan_hash: string;
    generated_at: string;
    delete_count: number;
    withheld_count: number;
    by_system: Record<string, number>;
    /**
     * The actions this plan will execute, named and grouped.
     *
     * Built from the stored plan rather than from the findings, because the
     * plan is the artifact that gets hashed, approved and executed - an
     * operator approving a hash should be able to read what that hash commits
     * them to, not a summary of what was discovered nearby.
     */
    actions: RecordGroup[];
  } | null;
  approval: {
    approved_by: string;
    approved_at: string;
    reason: string | null;
  } | null;
  certificate: {
    plan_hash: string;
    approved_by: string;
    executed_at: string;
    deleted_count: number;
    withheld_count: number;
    by_system: Record<string, number>;
    /**
     * What each adapter confirmed destroying, named and grouped.
     *
     * Stronger evidence than the plan: the plan is what was intended, this is
     * what happened. It is also the state a case spends most of its life in,
     * so "which records?" needs an answer here and not only at the gate.
     */
    actions: RecordGroup[];
  } | null;
  steps: Record<Phase, StepState>;
};

const SYSTEM_LABELS: Record<string, { label: string; unit: string }> = {
  postgres: { label: 'PostgreSQL', unit: 'records' },
  minio: { label: 'MinIO', unit: 'objects' },
  billing: { label: 'Billing', unit: 'records' },
};

function countBySystem(actions: PlanAction[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const action of actions)
    out[action.system] = (out[action.system] || 0) + 1;
  return out;
}

/**
 * Keys a recorder has been seen to nest the source row under.
 *
 * The deterministic script names the wrapper after the thing it found - `row`
 * for table rows, but `account`, `customer` and `object` elsewhere - so a
 * single `row` lookup finds the row for most record types and misses it for
 * exactly the ones whose names matter most to a reader: the account and the
 * billing customer, both of which would fall back to a bare id.
 */
const ROW_WRAPPERS = ['row', 'account', 'customer', 'object'] as const;

/**
 * The source row behind a finding, whichever way the recorder shaped it.
 *
 * finding_add documents metadata as "the source row", so an agent reading that
 * literally sends the row's own columns, while the deterministic script nests
 * it. Both are fair readings and the recorder is a language model, so this
 * accepts either rather than losing a record's name to a nesting choice. A
 * wrapper wins when present, so a flat row carrying its own `row` column is
 * not mistaken for one.
 */
function sourceRow(finding: Finding): Record<string, unknown> {
  const metadata = finding.metadata as Record<string, unknown> | undefined;
  if (!metadata || typeof metadata !== 'object') return {};
  for (const key of ROW_WRAPPERS) {
    const nested = metadata[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
  }
  return metadata;
}

/**
 * A retained refund's human-readable detail lives in the finding's metadata
 * snapshot of the source row, not in the plan action - the action carries only
 * the identity triple. Fall back gracefully: a withheld record with no metadata
 * must still render, because "we are not deleting this" is the claim that
 * matters, and the reason is supporting detail.
 */
function toWithheld(finding: Finding): WithheldRecord {
  const row = sourceRow(finding);
  return {
    system: finding.system,
    record_type: finding.record_type,
    record_id: String(finding.record_id),
    disposition: finding.disposition,
    order_number:
      typeof row.source_order_number === 'string'
        ? row.source_order_number
        : undefined,
    amount_cents:
      typeof row.amount_cents === 'number' ? row.amount_cents : undefined,
    reason: typeof row.reason === 'string' ? row.reason : undefined,
  };
}

function buildSteps(record: CaseRecord): Record<Phase, StepState> {
  const { status } = record;
  const failed = status === 'failed';
  const hasPlan = record.plans.length > 0;
  const hasApproval = record.approvals.length > 0;
  const hasCertificate = Boolean(record.certificate);

  const discovery: StepState = record.discovery_completed_at
    ? 'done'
    : failed
      ? 'failed'
      : 'active';
  const planning: StepState = hasPlan
    ? 'done'
    : discovery === 'done'
      ? 'active'
      : 'pending';
  // The sandbox rehearsal is not recorded in the case store - prepare() runs it
  // and refuses to return a plan that never rehearsed cleanly. So a stored plan
  // is itself the evidence that rehearsal passed.
  const sandbox: StepState = hasPlan ? 'done' : 'pending';
  const approval: StepState = hasApproval
    ? 'done'
    : hasPlan
      ? 'active'
      : 'pending';
  const execution: StepState = hasCertificate
    ? 'done'
    : status === 'executing'
      ? 'active'
      : failed
        ? 'failed'
        : hasApproval
          ? 'active'
          : 'pending';
  const certificate: StepState = hasCertificate ? 'done' : 'pending';

  return { discovery, planning, sandbox, approval, execution, certificate };
}

/**
 * How many records of one kind to name before summarising the rest.
 *
 * A subject's event log runs to hundreds of rows on the full fixture, and
 * listing every id would bury the handful of records an operator can actually
 * reason about. The cap is a display decision only: the counts beside each
 * group are the real totals, and the ground-truth panel checks those.
 */
const ITEMS_PER_GROUP = 8;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

/**
 * How one record is described to a human.
 *
 * Findings carry the source row, so a record can be named the way the business
 * names it - order SK-08004, not order 4 - which is the difference between a
 * list an operator skims and one they can actually check against the systems.
 * Every branch falls back to the id, because a finding recorded without its row
 * must still be shown rather than silently dropped.
 */
function describe(finding: Finding): string {
  const row = sourceRow(finding);
  const id = String(finding.record_id);
  switch (finding.record_type) {
    case 'account':
    case 'account_email':
    case 'customer':
      return str(row.email) ?? id;
    case 'order':
      return str(row.order_number) ?? `order ${id}`;
    case 'order_item': {
      // The sku goes first because the same product legitimately appears on
      // several orders, and a list of repeated product names reads as a bug
      // rather than as distinct line items.
      const sku = str(row.sku);
      const name = str(row.product_name);
      if (sku && name) return `${sku} · ${name}`;
      return sku ?? name ?? `item ${id}`;
    }
    case 'refund':
    case 'retained_refund': {
      // A refund row references its order by id, not by order number, so the
      // amount is the only detail on it that means anything to a reader - and
      // for the withheld one it is the whole point: money still owed.
      const order = str(row.source_order_number) ?? str(row.order_number);
      const amount =
        typeof row.amount_cents === 'number'
          ? `$${(row.amount_cents / 100).toFixed(2)}`
          : undefined;
      if (order && amount) return `${order} · ${amount}`;
      return order ?? amount ?? `refund ${id}`;
    }
    case 'support_ticket':
      return str(row.subject) ?? `ticket ${id}`;
    case 'upload':
    case 'object':
      return str(row.object_key) ?? str(finding.locator) ?? id;
    case 'event': {
      // Event findings are stored as bare ids - the adapter returns ids rather
      // than hundreds of rows - so the row here was filled in for display (see
      // lib/event-detail). The address comes first: months of this subject's
      // history sit under an address they no longer use, and seeing which
      // entries were filed under the old one is the identity-chain trap made
      // visible rather than asserted.
      const path = str(row.path);
      if (!path) return `entry ${id}`;
      const request = `${str(row.method) ?? ''} ${path}`.trim();
      const who = str(row.email) ?? str(row.ip_address);
      const when = str(row.ts)?.slice(0, 10);
      return [who, request, when].filter(Boolean).join(' · ');
    }
    default:
      return id;
  }
}

const GROUP_NOTES: Record<string, string> = {
  customer:
    'The customer record is kept as a tombstone. The card, charge history, name and email are redacted.',
  event:
    'Stored as ids only - the adapter returns ids rather than hundreds of rows. The detail shown here is read from the log for display, so it is gone once these rows are.',
  retained_refund: 'Withheld. A live financial obligation cannot be erased.',
};

/** Group one system's findings by record type, naming a sample of each. */
function groupFindings(findings: Finding[]): RecordGroup[] {
  // Keyed by system as well as type, because an uploaded file is two records:
  // the index row in Postgres and the object itself in storage. They share a
  // key, so grouping on type alone lists the same path twice with nothing to
  // say why - which reads as a duplication bug rather than as the two distinct
  // deletions it actually is.
  const byType = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = `${finding.system}:${finding.record_type}`;
    const bucket = byType.get(key);
    if (bucket) bucket.push(finding);
    else byType.set(key, [finding]);
  }

  return [...byType.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([, group]) => ({
      system: group[0].system,
      record_type: group[0].record_type,
      count: group.length,
      items: group.slice(0, ITEMS_PER_GROUP).map((finding) => ({
        record_id: String(finding.record_id),
        label: describe(finding),
      })),
      hidden: Math.max(0, group.length - ITEMS_PER_GROUP),
      note: GROUP_NOTES[group[0].record_type],
    }));
}

export function buildCaseView(record: CaseRecord): CaseView {
  const findings = record.findings ?? [];
  const withheldFindings = findings.filter((f) => f.disposition !== 'erase');
  const eraseFindings = findings.filter((f) => f.disposition === 'erase');

  const perSystem: Record<string, number> = {};
  for (const finding of findings)
    perSystem[finding.system] = (perSystem[finding.system] || 0) + 1;

  const systems: SystemCard[] = (['postgres', 'minio', 'billing'] as const).map(
    (key) => ({
      key,
      label: SYSTEM_LABELS[key].label,
      unit: SYSTEM_LABELS[key].unit,
      count: perSystem[key] || 0,
      groups: groupFindings(findings.filter((f) => f.system === key)),
    }),
  );
  // Identity is not a storage system - it is how many addresses this person is
  // known by, which is the reason discovery has to look beyond the one email
  // that was typed in.
  const emailFindings = findings.filter(
    (f) => f.record_type === 'account_email',
  );
  systems.push({
    key: 'identity',
    label: 'Identity',
    unit: 'emails',
    count: emailFindings.length,
    groups: groupFindings(emailFindings),
  });

  const latestPlan = record.plans?.length
    ? record.plans[record.plans.length - 1]
    : null;
  const planActions = latestPlan?.body?.actions ?? [];
  const planErase = planActions.filter((a) => a.disposition === 'erase');

  // A plan action carries only the identity triple, so on its own it can say
  // "order 4" and never "SK-08004". The finding it came from holds the source
  // row, so the plan supplies what will be deleted and the finding supplies
  // what to call it. An action with no matching finding still renders, by id:
  // an unexplained entry in a deletion plan is the last thing to hide.
  const findingByKey = new Map(
    findings.map((f) => [`${f.system}:${f.record_type}:${f.record_id}`, f]),
  );
  const nameActions = (actions: PlanAction[]): Finding[] =>
    actions.map(
      (action) =>
        findingByKey.get(
          `${action.system}:${action.record_type}:${action.record_id}`,
        ) ?? ({ ...action, metadata: undefined } as unknown as Finding),
    );

  const latestApproval = record.approvals?.length
    ? record.approvals[record.approvals.length - 1]
    : null;
  const cert = record.certificate;

  return {
    case_id: record.id,
    subject_email: record.subject_email,
    subject_name: record.subject_name,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
    revision: record.revision,
    discovery_complete: Boolean(record.discovery_completed_at),
    systems,
    totals: {
      findings: findings.length,
      erase: eraseFindings.length,
      withheld: withheldFindings.length,
    },
    withheld: withheldFindings.map(toWithheld),
    plan: latestPlan
      ? {
          version: latestPlan.version,
          plan_hash: latestPlan.plan_hash,
          generated_at: latestPlan.body.generated_at,
          delete_count: planErase.length,
          withheld_count: planActions.length - planErase.length,
          by_system: countBySystem(planErase),
          actions: groupFindings(nameActions(planErase)),
        }
      : null,
    approval: latestApproval
      ? {
          approved_by: latestApproval.approved_by,
          approved_at: latestApproval.approved_at,
          reason: latestApproval.reason,
        }
      : null,
    certificate: cert
      ? {
          plan_hash: cert.plan_hash,
          approved_by: cert.approved_by,
          executed_at: cert.executed_at,
          deleted_count: cert.manifest.length,
          withheld_count: cert.withheld.length,
          by_system: countBySystem(cert.manifest),
          actions: groupFindings(nameActions(cert.manifest)),
        }
      : null,
    steps: buildSteps(record),
  };
}
