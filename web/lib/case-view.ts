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

export type SystemCard = {
  key: SystemKey;
  label: string;
  unit: string;
  count: number;
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
 * The source row behind a finding, whichever way the recorder shaped it.
 *
 * finding_add documents metadata as "the source row", so an agent reading that
 * literally sends the row's own columns, while the deterministic script nests
 * it as { row }. Both are fair readings and the recorder is a language model,
 * so the panel accepts either rather than losing the retention reason to a
 * nesting choice. Wrapped form wins when present, so a row with its own `row`
 * column is not mistaken for the wrapper.
 */
function sourceRow(finding: Finding): Record<string, unknown> {
  const metadata = finding.metadata as Record<string, unknown> | undefined;
  if (!metadata || typeof metadata !== 'object') return {};
  const nested = metadata.row;
  return nested && typeof nested === 'object'
    ? (nested as Record<string, unknown>)
    : metadata;
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
    }),
  );
  // Identity is not a storage system - it is how many addresses this person is
  // known by, which is the reason discovery has to look beyond the one email
  // that was typed in.
  systems.push({
    key: 'identity',
    label: 'Identity',
    unit: 'emails',
    count: findings.filter((f) => f.record_type === 'account_email').length,
  });

  const latestPlan = record.plans?.length
    ? record.plans[record.plans.length - 1]
    : null;
  const planActions = latestPlan?.body?.actions ?? [];
  const planErase = planActions.filter((a) => a.disposition === 'erase');

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
        }
      : null,
    steps: buildSteps(record),
  };
}
