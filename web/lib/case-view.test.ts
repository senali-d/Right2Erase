import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCaseView } from './case-view.ts';
import type { CaseRecord, Finding, PlanAction } from './mcp.ts';

// Shaped after a real case_get response for the seeded subject: two known
// addresses, orders and events in Postgres, one avatar object in MinIO, one
// billing customer, and the one retained refund that must survive.
function finding(over: Partial<Finding> & Pick<Finding, 'system' | 'record_type' | 'record_id'>): Finding {
  return {
    id: 0,
    case_id: 'case-1',
    locator: null,
    metadata: {},
    disposition: 'erase',
    created_at: '2026-08-28T17:19:11.642Z',
    ...over,
  } as Finding;
}

function action(over: Partial<PlanAction> & Pick<PlanAction, 'system' | 'record_type' | 'record_id'>): PlanAction {
  return { locator: null, disposition: 'erase', ...over } as PlanAction;
}

function baseCase(over: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: 'case-1',
    subject_email: 'ravi.sharma@example.com',
    subject_name: null,
    status: 'planned',
    created_at: '2026-08-28T17:19:11.557Z',
    updated_at: '2026-08-28T17:19:12.337Z',
    revision: 8,
    discovery_completed_at: '2026-08-28T17:19:12.328Z',
    findings: [
      finding({ system: 'postgres', record_type: 'account_email', record_id: '201' }),
      finding({ system: 'postgres', record_type: 'account_email', record_id: '202' }),
      finding({ system: 'postgres', record_type: 'order', record_id: '8004' }),
      finding({ system: 'postgres', record_type: 'account', record_id: '201' }),
      finding({
        system: 'postgres',
        record_type: 'retained_refund',
        record_id: '1',
        disposition: 'retain',
        metadata: {
          row: {
            id: 1,
            source_order_number: 'SK-08004',
            amount_cents: 4230,
            reason: 'Item returned, inspection pending',
          },
        },
      }),
      finding({ system: 'minio', record_type: 'object', record_id: 'uploads/acct_201/avatar.png' }),
      finding({ system: 'billing', record_type: 'customer', record_id: 'cus_9' }),
    ],
    plans: [
      {
        id: 1,
        case_id: 'case-1',
        version: 1,
        plan_hash: 'a'.repeat(64),
        case_revision: 8,
        created_at: '2026-08-28T17:19:12.337Z',
        body: {
          case_id: 'case-1',
          generated_at: '2026-08-28T17:19:12.330Z',
          actions: [
            action({ system: 'postgres', record_type: 'account_email', record_id: 201 }),
            action({ system: 'postgres', record_type: 'account_email', record_id: 202 }),
            action({ system: 'postgres', record_type: 'order', record_id: 8004 }),
            action({ system: 'postgres', record_type: 'account', record_id: 201 }),
            action({ system: 'postgres', record_type: 'retained_refund', record_id: 1, disposition: 'retain' }),
            action({ system: 'minio', record_type: 'object', record_id: 'uploads/acct_201/avatar.png' }),
            action({ system: 'billing', record_type: 'customer', record_id: 'cus_9' }),
          ],
        },
      },
    ],
    approvals: [],
    ...over,
  } as CaseRecord;
}

test('system cards count findings per system and surface identity separately', () => {
  const view = buildCaseView(baseCase());
  const byKey = Object.fromEntries(view.systems.map((s) => [s.key, s.count]));
  assert.equal(byKey.postgres, 5);
  assert.equal(byKey.minio, 1);
  assert.equal(byKey.billing, 1);
  // Identity counts known addresses, and deliberately overlaps the Postgres
  // card - it answers a different question than "how many rows".
  assert.equal(byKey.identity, 2);
});

test('withheld records are the non-erase findings, enriched from their source row', () => {
  const view = buildCaseView(baseCase());
  assert.equal(view.totals.withheld, 1);
  assert.equal(view.totals.erase, 6);
  assert.deepEqual(view.withheld, [
    {
      system: 'postgres',
      record_type: 'retained_refund',
      record_id: '1',
      disposition: 'retain',
      order_number: 'SK-08004',
      amount_cents: 4230,
      reason: 'Item returned, inspection pending',
    },
  ]);
});

test('a withheld record with no metadata still renders', () => {
  const record = baseCase();
  record.findings = [finding({ system: 'postgres', record_type: 'retained_refund', record_id: '7', disposition: 'retain' })];
  const [withheld] = buildCaseView(record).withheld;
  assert.equal(withheld.record_id, '7');
  assert.equal(withheld.reason, undefined);
});

test('plan splits erase from withheld and counts deletions per system', () => {
  const view = buildCaseView(baseCase());
  assert.equal(view.plan?.delete_count, 6);
  assert.equal(view.plan?.withheld_count, 1);
  // The retained refund must not be counted as a Postgres deletion.
  assert.deepEqual(view.plan?.by_system, { postgres: 4, minio: 1, billing: 1 });
});

test('the latest plan wins when a case has been re-planned', () => {
  const record = baseCase();
  record.plans = [
    { ...record.plans[0], version: 1, plan_hash: 'b'.repeat(64) },
    { ...record.plans[0], version: 2, plan_hash: 'c'.repeat(64) },
  ];
  assert.equal(buildCaseView(record).plan?.plan_hash, 'c'.repeat(64));
});

test('steps show approval as the active gate once a plan exists', () => {
  const view = buildCaseView(baseCase());
  assert.deepEqual(view.steps, {
    discovery: 'done',
    planning: 'done',
    sandbox: 'done',
    approval: 'active',
    execution: 'pending',
    certificate: 'pending',
  });
});

test('steps show discovery still active before it completes', () => {
  const record = baseCase({ status: 'discovered', discovery_completed_at: null, plans: [] });
  const view = buildCaseView(record);
  assert.equal(view.steps.discovery, 'active');
  assert.equal(view.steps.planning, 'pending');
  assert.equal(view.plan, null);
});

test('a certificate completes every step and reports per-system deletions', () => {
  const record = baseCase({
    status: 'completed',
    approvals: [
      {
        id: 1,
        case_id: 'case-1',
        plan_hash: 'a'.repeat(64),
        case_revision: 8,
        approved_by: 'operator',
        reason: null,
        approved_at: '2026-08-28T17:20:00.000Z',
      },
    ],
    certificate: {
      id: 1,
      case_id: 'case-1',
      plan_hash: 'a'.repeat(64),
      approved_by: 'operator',
      executed_at: '2026-08-28T17:20:05.000Z',
      manifest: [
        action({ system: 'postgres', record_type: 'account', record_id: 201 }),
        action({ system: 'minio', record_type: 'object', record_id: 'uploads/acct_201/avatar.png' }),
      ],
      withheld: [action({ system: 'postgres', record_type: 'retained_refund', record_id: 1, disposition: 'retain' })],
    },
  });
  const view = buildCaseView(record);
  assert.equal(view.certificate?.deleted_count, 2);
  assert.equal(view.certificate?.withheld_count, 1);
  assert.deepEqual(view.certificate?.by_system, { postgres: 1, minio: 1 });
  assert.equal(view.steps.execution, 'done');
  assert.equal(view.steps.certificate, 'done');
  assert.equal(view.approval?.approved_by, 'operator');
});

test('a failed case marks execution failed rather than done', () => {
  const record = baseCase({
    status: 'failed',
    approvals: [
      {
        id: 1,
        case_id: 'case-1',
        plan_hash: 'a'.repeat(64),
        case_revision: 8,
        approved_by: 'operator',
        reason: null,
        approved_at: '2026-08-28T17:20:00.000Z',
      },
    ],
  });
  const view = buildCaseView(record);
  assert.equal(view.steps.execution, 'failed');
  assert.equal(view.steps.certificate, 'pending');
  assert.equal(view.certificate, null);
});
