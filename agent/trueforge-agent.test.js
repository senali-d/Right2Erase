import test from 'node:test';
import assert from 'node:assert/strict';
import { APPROVAL_REQUIRED_TOOLS, DISCOVERY_TOOLS, createTrueForgeAgent } from './trueforge-agent.js';

test('discovery tools are allowlisted and only Oubliette execution is destructive', () => {
  assert.equal(DISCOVERY_TOOLS.has('db_find_accounts'), true);
  assert.equal(DISCOVERY_TOOLS.has('billing_preview_erase'), true);
  assert.deepEqual([...APPROVAL_REQUIRED_TOOLS], ['oubliette_execute_erasure']);
});

test('agent stops at approval and never executes without consent', async () => {
  const calls = [];
  const agent = createTrueForgeAgent({
    callTool: async (tool, args) => {
      calls.push(tool);
      if (tool === 'plan_approve' || tool === 'oubliette_execute_erasure') throw new Error('must not be called');
      return { case_id: args.case_id || 'case-1', plan_hash: 'a'.repeat(64) };
    },
    requestApproval: async () => false,
  });

  const result = await agent.executeApproved({ case_id: 'case-1', plan_hash: 'a'.repeat(64), approved_by: 'captain' });
  assert.equal(result.awaiting_approval, true);
  assert.equal(result.executed, false);
  assert.deepEqual(calls, []);
});

test('agent approves before invoking the sole destructive tool', async () => {
  const calls = [];
  const agent = createTrueForgeAgent({
    callTool: async (tool) => {
      calls.push(tool);
      return tool === 'plan_approve' ? { approved: true } : { certificate: { case_id: 'case-1' } };
    },
    requestApproval: async () => true,
  });

  const result = await agent.executeApproved({ case_id: 'case-1', plan_hash: 'a'.repeat(64), approved_by: 'captain' });
  assert.equal(result.executed, true);
  assert.deepEqual(calls, ['plan_approve', 'oubliette_execute_erasure']);
});

function rowsResponder(overrides = {}) {
  const empty = { rows: [] };
  const emptyObjects = { objects: [], truncated: false, limit: 1000 };
  const handlers = {
    case_create: async () => ({ case_id: 'case-1' }),
    db_find_accounts: async () => ({ rows: [{ id: 'acct_1' }] }),
    billing_find_customer: async () => ({ results: [] }),
    db_get_account_emails: async () => empty,
    db_list_orders: async () => empty,
    db_list_support_tickets: async () => empty,
    db_search_uploads: async () => empty,
    storage_list_objects: async () => emptyObjects,
    db_search_event_log: async () => empty,
    storage_search_objects: async () => emptyObjects,
    finding_add: async () => ({ ok: true }),
    case_complete_discovery: async () => ({ ok: true }),
    plan_create: async () => ({ plan_hash: 'a'.repeat(64) }),
    ...overrides,
  };
  return async (tool, args) => {
    if (!(tool in handlers)) throw new Error(`unexpected tool call: ${tool}`);
    return handlers[tool](args);
  };
}

test('MinIO discovery searches the account prefix and dedupes against the email search', async () => {
  const findings = [];
  const callTool = rowsResponder({
    db_find_accounts: async () => ({ rows: [{ id: 'acct_1', matched_via: 'current_email' }] }),
    storage_list_objects: async ({ prefix }) => {
      if (prefix === 'uploads/acct_acct_1/') {
        return { objects: [{ key: 'uploads/acct_1/a.png' }, { key: 'uploads/acct_1/b.png' }], truncated: false, limit: 1000 };
      }
      return { objects: [], truncated: false, limit: 1000 };
    },
    storage_search_objects: async () => ({
      objects: [{ key: 'uploads/acct_1/a.png' }, { key: 'orphan/subject@example.com.png' }],
      truncated: false,
      limit: 1000,
    }),
    finding_add: async (args) => {
      findings.push(args);
      return { ok: true };
    },
  });

  const agent = createTrueForgeAgent({ callTool });
  await agent.prepare({ subject_email: 'subject@example.com' });

  const minioKeys = findings.filter((f) => f.system === 'minio').map((f) => f.record_id).sort();
  assert.deepEqual(minioKeys, [
    'orphan/subject@example.com.png',
    'uploads/acct_1/a.png',
    'uploads/acct_1/b.png',
  ]);
});

test('multiple distinct accounts matching subject_email are rejected before a case is ever created', async () => {
  const findings = [];
  const calls = [];
  const callTool = rowsResponder({
    case_create: async () => { calls.push('case_create'); return { case_id: 'case-1' }; },
    db_find_accounts: async () => ({
      rows: [
        { id: 'acct_1', matched_via: 'historical_email' },
        { id: 'acct_2', matched_via: 'current_email' },
      ],
    }),
    finding_add: async (args) => {
      findings.push(args);
      return { ok: true };
    },
  });

  const agent = createTrueForgeAgent({ callTool });

  await assert.rejects(
    agent.prepare({ subject_email: 'subject@example.com' }),
    /ambiguous identity/,
  );
  assert.deepEqual(findings, []);
  // No case must ever be persisted for an identity collision - otherwise it
  // is left orphaned with no findings and no way to clean it up.
  assert.ok(!calls.includes('case_create'));
});

test('identity is resolved via db_find_accounts and billing_find_customer before a case is created', async () => {
  const calls = [];
  const callTool = rowsResponder({
    db_find_accounts: async () => { calls.push('db_find_accounts'); return { rows: [{ id: 'acct_1' }] }; },
    billing_find_customer: async () => { calls.push('billing_find_customer'); return { results: [] }; },
    case_create: async () => { calls.push('case_create'); return { case_id: 'case-1' }; },
  });

  const agent = createTrueForgeAgent({ callTool });
  await agent.prepare({ subject_email: 'subject@example.com' });

  const caseCreateIndex = calls.indexOf('case_create');
  assert.ok(caseCreateIndex > calls.indexOf('db_find_accounts'));
  assert.ok(caseCreateIndex > calls.indexOf('billing_find_customer'));
});

test('a truncated MinIO query refuses to plan an incomplete erasure', async () => {
  const callTool = rowsResponder({
    storage_list_objects: async () => ({ objects: [], truncated: true, limit: 1000 }),
  });
  const agent = createTrueForgeAgent({ callTool });

  await assert.rejects(
    agent.prepare({ subject_email: 'subject@example.com' }),
    /truncated/,
  );
});

test('discovery is marked complete only after every finding is recorded, before plan_create', async () => {
  const calls = [];
  const callTool = rowsResponder({
    finding_add: async () => { calls.push('finding_add'); return { ok: true }; },
    case_complete_discovery: async () => { calls.push('case_complete_discovery'); return { ok: true }; },
    plan_create: async () => { calls.push('plan_create'); return { plan_hash: 'a'.repeat(64) }; },
  });

  const agent = createTrueForgeAgent({ callTool });
  await agent.prepare({ subject_email: 'subject@example.com' });

  const completeIndex = calls.indexOf('case_complete_discovery');
  assert.notEqual(completeIndex, -1);
  assert.ok(calls.slice(0, completeIndex).every((call) => call === 'finding_add'));
  assert.deepEqual(calls.slice(completeIndex), ['case_complete_discovery', 'plan_create']);
});

test('a truncated storage query prevents discovery from ever being marked complete', async () => {
  const calls = [];
  const callTool = rowsResponder({
    finding_add: async () => { calls.push('finding_add'); return { ok: true }; },
    case_complete_discovery: async () => { calls.push('case_complete_discovery'); return { ok: true }; },
    plan_create: async () => { calls.push('plan_create'); return { plan_hash: 'a'.repeat(64) }; },
    // Postgres and billing findings are recorded before this final email
    // search runs, so this simulates the exact partial-persistence scenario.
    storage_search_objects: async () => ({ objects: [], truncated: true, limit: 1000 }),
  });

  const agent = createTrueForgeAgent({ callTool });
  await assert.rejects(agent.prepare({ subject_email: 'subject@example.com' }), /truncated/);

  assert.ok(calls.includes('finding_add'));
  assert.ok(!calls.includes('case_complete_discovery'));
  assert.ok(!calls.includes('plan_create'));
});

test('historical emails beyond 100 are batched into multiple db_search_event_log calls', async () => {
  const historicalEmails = Array.from({ length: 137 }, (_, i) => `alias${i}@example.com`);
  const eventLogCalls = [];
  const findings = [];
  const callTool = rowsResponder({
    db_find_accounts: async () => ({ rows: [{ id: 'acct_1', last_seen_ip: '10.0.0.1' }] }),
    db_get_account_emails: async () => ({ rows: historicalEmails.map((email, i) => ({ id: i, email })) }),
    db_search_event_log: async (args) => {
      eventLogCalls.push(args);
      // Each batch returns one row unique to it plus a row shared by IP across
      // every batch, mimicking the OR'd IP condition in the real query.
      const uniqueRow = { id: `unique-${eventLogCalls.length}`, email: args.emails[0] };
      const sharedRow = { id: 'shared-ip-row', ip_address: '10.0.0.1' };
      return { rows: [uniqueRow, sharedRow] };
    },
    finding_add: async (args) => {
      findings.push(args);
      return { ok: true };
    },
  });

  const agent = createTrueForgeAgent({ callTool });
  await agent.prepare({ subject_email: 'subject@example.com' });

  assert.equal(eventLogCalls.length, 2);
  assert.equal(eventLogCalls[0].emails.length, 100);
  assert.equal(eventLogCalls[1].emails.length, 38); // 137 historical + subject_email, batched
  assert.equal(eventLogCalls[0].ip_address, '10.0.0.1');
  assert.equal(eventLogCalls[1].ip_address, undefined);

  const eventFindings = findings.filter((f) => f.record_type === 'event');
  const eventIds = eventFindings.map((f) => f.record_id).sort();
  assert.deepEqual(eventIds, ['shared-ip-row', 'unique-1', 'unique-2']);
});

test('db_search_event_log batches run one at a time, never concurrently', async () => {
  const historicalEmails = Array.from({ length: 350 }, (_, i) => `alias${i}@example.com`);
  let inFlight = 0;
  let maxInFlight = 0;
  let callCount = 0;
  const callTool = rowsResponder({
    db_get_account_emails: async () => ({ rows: historicalEmails.map((email, i) => ({ id: i, email })) }),
    db_search_event_log: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      callCount += 1;
      // Yield so a buggy Promise.all-based implementation would overlap calls.
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return { rows: [] };
    },
  });

  const agent = createTrueForgeAgent({ callTool });
  await agent.prepare({ subject_email: 'subject@example.com' });

  assert.equal(callCount, 4); // 351 known emails (350 historical + subject_email) -> 4 batches of <=100
  assert.equal(maxInFlight, 1);
});

test('a truncated db_get_account_emails response refuses to plan an incomplete discovery', async () => {
  const calls = [];
  const callTool = rowsResponder({
    db_get_account_emails: async () => ({ rows: [], truncated: true, limit: 500 }),
    db_search_event_log: async () => { calls.push('db_search_event_log'); return { rows: [] }; },
    case_complete_discovery: async () => { calls.push('case_complete_discovery'); return { ok: true }; },
  });

  const agent = createTrueForgeAgent({ callTool });

  await assert.rejects(
    agent.prepare({ subject_email: 'subject@example.com' }),
    /db_get_account_emails.*truncated/,
  );
  assert.deepEqual(calls, []);
});
