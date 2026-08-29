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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseResult } from '../agent/create-agent.js';

const URL_ = process.env.OUBLIETTE_MCP_URL || 'http://127.0.0.1:4014/mcp';

async function connect() {
  const client = new Client({ name: 'oubliette-invariant-tests', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_)));
  return client;
}

let up = true;
try {
  const probe = await connect();
  await probe.close();
} catch {
  up = false;
}
const skip = up ? false : `oubliette MCP not reachable at ${URL_}; run npm run dev`;

async function call(name, args) {
  const client = await connect();
  try {
    return parseResult(await client.callTool({ name, arguments: args }));
  } finally {
    await client.close();
  }
}

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
