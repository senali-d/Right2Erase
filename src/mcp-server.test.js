/**
 * Adversarial tests for the Oubliette MCP surface.
 *
 * The case store's own guards are covered in db.test.js. These drive the tools
 * as an agent would, over a real MCP session, to prove the schema itself
 * refuses input the store would otherwise have to cope with.
 *
 * Skipped when the Oubliette adapter is not running, so `npm test` still
 * passes without the stack up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool, skipUnless } from '../mcp/test-client.js';

const URL_ = process.env.OUBLIETTE_MCP_URL || 'http://127.0.0.1:4014/mcp';

const skip = await skipUnless(URL_, 'oubliette');
const call = (name, args) => callTool(URL_, 'oubliette-invariant-tests', name, args);

async function newCase() {
  const created = await call('case_create', { subject_email: `agent-test-${Date.now()}@example.com` });
  return created.id;
}

test('a finding cannot name a system outside the closed vocabulary', { skip }, async () => {
  const caseId = await newCase();
  // "shopkart-db" is the MCP server's name, and is what an agent naturally
  // reaches for. It is not a system: nothing downstream can route it, so the
  // schema has to reject it rather than let it reach the store.
  await assert.rejects(
    call('finding_add', { case_id: caseId, system: 'shopkart-db', record_type: 'order', record_id: 1 }),
    /system/i,
  );
});

test('a finding cannot use a pluralised record type', { skip }, async () => {
  const caseId = await newCase();
  await assert.rejects(
    call('finding_add', { case_id: caseId, system: 'postgres', record_type: 'retained_refunds', record_id: 1 }),
    /record_type/i,
    'the plural bypassed the retention rule when record_type was free text',
  );
});

test('a retained refund is stored as retained even when erase is requested', { skip }, async () => {
  const caseId = await newCase();
  const finding = await call('finding_add', {
    case_id: caseId, system: 'postgres', record_type: 'retained_refund', record_id: 1, disposition: 'erase',
  });
  assert.equal(finding.disposition, 'retain');
});

test('a batch enforces the same vocabulary and retention rule as a single add', { skip }, async () => {
  const caseId = await newCase();
  await assert.rejects(
    call('finding_add_many', {
      case_id: caseId,
      findings: [
        { system: 'postgres', record_type: 'order', record_id: 1 },
        { system: 'shopkart-billing', record_type: 'customer', record_id: 'cus_1' },
      ],
    }),
    /system/i,
    'one bad row must reject the batch, not be quietly dropped from it',
  );

  const summary = await call('finding_add_many', {
    case_id: caseId,
    findings: [
      { system: 'postgres', record_type: 'order', record_id: 1 },
      { system: 'postgres', record_type: 'retained_refund', record_id: 2, disposition: 'erase' },
    ],
  });
  assert.equal(summary.added, 2);

  const subject = await call('case_get', { case_id: caseId });
  const retained = subject.findings.find((f) => f.record_type === 'retained_refund');
  assert.equal(retained.disposition, 'retain');
});

test('discovery cannot be completed for a case with no findings', { skip }, async () => {
  const caseId = await newCase();
  await assert.rejects(call('case_complete_discovery', { case_id: caseId }), /no findings/);
});

test('a plan cannot be built before discovery is marked complete', { skip }, async () => {
  const caseId = await newCase();
  await call('finding_add', { case_id: caseId, system: 'postgres', record_type: 'order', record_id: 1 });
  await assert.rejects(call('plan_create', { case_id: caseId }), /has not completed discovery/);
});

test('execution refuses an approver identity that disagrees with the recorded approval', { skip }, async () => {
  const caseId = await newCase();
  await call('finding_add', { case_id: caseId, system: 'postgres', record_type: 'order', record_id: 1 });
  await call('case_complete_discovery', { case_id: caseId });
  const plan = await call('plan_create', { case_id: caseId });
  await call('plan_approve', { case_id: caseId, plan_hash: plan.plan_hash, approved_by: 'the-operator' });

  // A caller may assert who approved, and a wrong assertion is refused. It is
  // never a way to nominate an approver: the recorded approval is the
  // authority, and this is the check that keeps a claimed name from becoming
  // one.
  await assert.rejects(
    call('oubliette_execute_erasure', {
      case_id: caseId, plan_hash: plan.plan_hash, approved_by: 'somebody-else',
    }),
    /approved_by does not match the approving identity/,
  );
});

test('a built plan carries the retained refund as withheld, never as an erase action', { skip }, async () => {
  const caseId = await newCase();
  await call('finding_add_many', {
    case_id: caseId,
    findings: [
      { system: 'postgres', record_type: 'order', record_id: 1 },
      { system: 'postgres', record_type: 'retained_refund', record_id: 1, disposition: 'erase' },
    ],
  });
  await call('case_complete_discovery', { case_id: caseId });
  const plan = await call('plan_create', { case_id: caseId });

  const retained = plan.body.actions.filter((a) => a.record_type === 'retained_refund');
  assert.equal(retained.length, 1);
  assert.equal(retained[0].disposition, 'retain', 'the plan a human signs must not claim to delete it');
});

test('finding_add_many records a whole result set from ids alone', { skip }, async () => {
  const caseId = await newCase();
  await call('finding_add_many', {
    case_id: caseId,
    record_ids: [11, 12, 13],
    system: 'postgres',
    record_type: 'event',
  });
  await call('case_complete_discovery', { case_id: caseId });
  const plan = await call('plan_create', { case_id: caseId });

  const events = plan.body.actions.filter((a) => a.record_type === 'event');
  // record_id is a TEXT column, so ids come back as strings whichever form
  // recorded them - the compact form is not a second storage path.
  assert.deepEqual(events.map((a) => a.record_id).sort(), ['11', '12', '13']);
  assert.ok(events.every((a) => a.disposition === 'erase'));
});

test('the compact form still cannot erase a retained refund', { skip }, async () => {
  const caseId = await newCase();
  await call('finding_add_many', {
    case_id: caseId, record_ids: [1], system: 'postgres', record_type: 'retained_refund', disposition: 'erase',
  });
  await call('case_complete_discovery', { case_id: caseId });
  const plan = await call('plan_create', { case_id: caseId });

  const retained = plan.body.actions.filter((a) => a.record_type === 'retained_refund');
  assert.equal(retained.length, 1);
  assert.equal(retained[0].disposition, 'retain');
});

test('finding_add_many refuses a call that gives both forms, or neither', { skip }, async () => {
  const caseId = await newCase();
  const findings = [{ system: 'postgres', record_type: 'event', record_id: 1 }];
  await assert.rejects(
    call('finding_add_many', {
      case_id: caseId, findings, record_ids: [1], system: 'postgres', record_type: 'event',
    }),
    /exactly one of findings or record_ids/,
  );
  await assert.rejects(call('finding_add_many', { case_id: caseId }), /exactly one of findings or record_ids/);
  // Ids with no type to give them is a batch that cannot be recorded, not one
  // to guess a record_type for.
  await assert.rejects(
    call('finding_add_many', { case_id: caseId, record_ids: [1] }),
    /record_ids requires system and record_type/,
  );
});
