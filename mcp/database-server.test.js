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
import { callTool, skipUnless } from './test-client.js';

const DB_URL = process.env.SHOPKART_DB_MCP_URL || 'http://127.0.0.1:4012/mcp';

const AGENT = 'adapter-invariant-tests';
const skipDb = await skipUnless(DB_URL, 'shopkart-db', 'database');
const call = (url, name, args) => callTool(url, AGENT, 'database', name, args);

/**
 * The subject's account id, asked for rather than assumed.
 *
 * It used to be written here as the literal 201, which is only true when the
 * fixture seeds exactly 200 background accounts before him - so these tests
 * silently failed for anyone running a different SEED_ACCOUNTS or SEED_PROFILE,
 * on a fixture that was perfectly well formed. The address is the stable
 * identity; the id is an implementation detail of how many rows came first.
 */
let subjectId;
async function subjectAccountId() {
  if (subjectId === undefined) {
    const [account] = await call(DB_URL, 'db_find_accounts', { email: 'ravi.sharma@example.com' });
    assert.ok(account,
      'the fixture needs the subject; a completed erasure run removes him, so re-seed with ./scripts/demo-reset.sh');
    subjectId = account.id;
  }
  return subjectId;
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
  const response = await call(DB_URL, 'db_get_account_emails', { account_id: await subjectAccountId() });
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

  assert.ok(plain.count > 0, 'the fixture seeds event-log rows for the subject');
  assert.deepEqual(
    [...batched.event_ids].sort((a, b) => a - b),
    [...plain.event_ids].sort((a, b) => a - b),
    'batching must not drop or duplicate rows',
  );
  assert.equal(new Set(batched.event_ids).size, batched.event_ids.length, 'IP-matched rows must not repeat once per batch');
  assert.equal(batched.count, batched.event_ids.length);

  // Ids, not rows: the full set is what the harness would offload out of the
  // conversation, so the response must stay small no matter how many rows match.
  assert.ok(batched.sample.length <= 3, 'sample must stay small');
  assert.ok(
    JSON.stringify(batched).length < 24_000,
    `event-log response must stay well under the offload threshold, got ${JSON.stringify(batched).length} bytes`,
  );
});

test('db_search_uploads returns linked and orphaned rows from a single call', { skip: skipDb }, async () => {
  const id = await subjectAccountId();
  const rows = await call(DB_URL, 'db_search_uploads', { account_id: id, object_prefix: `uploads/acct_${id}/` });
  assert.ok(rows.some((row) => row.account_id === id), 'linked upload missing');
  assert.ok(rows.some((row) => row.account_id === null), 'orphaned upload missing');
});

test('db_search_uploads never surfaces another account orphan-recovery row', { skip: skipDb }, async () => {
  // The prefix branch is scoped to account_id IS NULL, so it can only ever add
  // genuinely orphaned rows - never one already linked to a different person.
  const rows = await call(DB_URL, 'db_search_uploads', { object_prefix: 'uploads/acct_' });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.account_id === null));
});
