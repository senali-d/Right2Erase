/**
 * Adversarial tests for the ShopKart adapters' safety invariants.
 *
 * These guards used to live in the agent, where they held only because the
 * caller was a fixed script. They now live in the adapters, and these tests
 * drive the tools directly - no agent involved - so a passing run means the
 * guarantee survives any caller, including a model that reasons badly.
 *
 * Requires the seeded fixture stack (`npm run setup`). Skipped when Postgres
 * is unreachable, so `npm test` still passes on a machine with no Docker.
 *
 * Storage adapter invariants live in storage-server.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseResult } from '../agent/create-agent.js';

const DB_URL = process.env.SHOPKART_DB_MCP_URL || 'http://127.0.0.1:4012/mcp';

async function connect(url) {
  const client = new Client({ name: 'adapter-invariant-tests', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

async function reachable(url) {
  try {
    const client = await connect(url);
    await client.close();
    return true;
  } catch {
    return false;
  }
}

const dbUp = await reachable(DB_URL);
const skipDb = dbUp ? false : `shopkart-db MCP not reachable at ${DB_URL}; run npm run dev`;

async function call(url, name, args) {
  const client = await connect(url);
  try {
    return parseResult(await client.callTool({ name, arguments: args }));
  } finally {
    await client.close();
  }
}

test('db_find_accounts refuses an email that resolves to more than one account', { skip: skipDb }, async () => {
  // The seeded fixture has no colliding address, so create the collision the
  // guard exists for: recycle the subject's historical address onto the decoy
  // account, which shares the subject's display name.
  const pg = (await import('pg')).default;
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL || 'postgres://shopkart:shopkart@localhost:5432/shopkart',
  });
  await client.connect();
  const recycled = `collision-${Date.now()}@example.com`;
  const { rows } = await client.query("SELECT id FROM accounts WHERE email = ANY($1::text[]) ORDER BY id", [
    ['ravi.sharma@example.com', 'r.sharma@example.net'],
  ]);
  assert.equal(rows.length, 2,
    'the fixture needs both the subject and the decoy; a completed erasure run removes the subject, so re-seed with ./scripts/demo-reset.sh');
  try {
    for (const row of rows) {
      await client.query(
        'INSERT INTO account_emails (account_id, email, is_primary, valid_from) VALUES ($1, $2, false, now())',
        [row.id, recycled],
      );
    }
    await assert.rejects(
      call(DB_URL, 'db_find_accounts', { email: recycled }),
      /ambiguous identity/,
      'one address matching two accounts must be refused, never resolved by picking one',
    );
  } finally {
    await client.query('DELETE FROM account_emails WHERE email = $1', [recycled]);
    await client.end();
  }
});

test('db_find_accounts still returns several accounts for a shared display name', { skip: skipDb }, async () => {
  // The collision guard is scoped to email matches: a shared name is the
  // expected shape, and is exactly why name alone must not select a target.
  const found = await call(DB_URL, 'db_find_accounts', { full_name: 'Ravi Sharma' });
  assert.ok(found.length > 1, 'the fixture seeds a decoy sharing the subject display name');
  assert.ok(found.every((row) => row.matched_via === 'full_name'));
});

test('db_get_account_emails returns every address in one call, with no paging left to the caller', { skip: skipDb }, async () => {
  const response = await call(DB_URL, 'db_get_account_emails', { account_id: 201 });
  assert.equal(response.truncated, false);
  assert.equal(response.next_cursor, null);
  const addresses = response.rows.map((row) => row.email);
  // Both the current and the historical address, without a second call.
  assert.ok(addresses.includes('ravi.sharma@example.com'));
  assert.ok(addresses.includes('ravi.s@oldmail.example'));
});

test('db_search_event_log batches internally and dedupes IP-matched rows', { skip: skipDb }, async () => {
  const subject = ['ravi.sharma@example.com', 'ravi.s@oldmail.example'];
  // Pad past one batch so the batching path runs; the padding matches nothing,
  // so the result must equal the unpadded result exactly.
  const padded = [...subject, ...Array.from({ length: 150 }, (_, i) => `filler-${i}@example.invalid`)];

  const [plain, batched] = await Promise.all([
    call(DB_URL, 'db_search_event_log', { emails: subject, ip_address: '203.0.113.47' }),
    call(DB_URL, 'db_search_event_log', { emails: padded, ip_address: '203.0.113.47' }),
  ]);

  assert.ok(plain.length > 0, 'the fixture seeds event-log rows for the subject');
  assert.deepEqual(
    batched.map((row) => row.id).sort((a, b) => a - b),
    plain.map((row) => row.id).sort((a, b) => a - b),
    'batching must not drop or duplicate rows',
  );
  const ids = batched.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, 'IP-matched rows must not repeat once per batch');
});

test('db_search_uploads returns linked and orphaned rows from a single call', { skip: skipDb }, async () => {
  const rows = await call(DB_URL, 'db_search_uploads', { account_id: 201, object_prefix: 'uploads/acct_201/' });
  assert.ok(rows.some((row) => row.account_id === 201), 'linked upload missing');
  assert.ok(rows.some((row) => row.account_id === null), 'orphaned upload missing');
});

test('db_search_uploads never surfaces another account orphan-recovery row', { skip: skipDb }, async () => {
  // The prefix branch is scoped to account_id IS NULL, so it can only ever add
  // genuinely orphaned rows - never one already linked to a different person.
  const rows = await call(DB_URL, 'db_search_uploads', { object_prefix: 'uploads/acct_' });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.account_id === null));
});
