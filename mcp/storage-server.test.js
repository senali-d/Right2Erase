/**
 * Adversarial tests for the ShopKart storage adapter.
 *
 * The listing cap used to be a silent truncation the caller was trusted to
 * notice. It is now a refusal, because a partial object listing is
 * indistinguishable from a complete one and planning an erasure from one
 * silently leaves the subject's files in place. These drive the tools directly,
 * with no agent involved.
 *
 * Skipped when the adapter is not running, so `npm test` still passes without
 * the stack up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool, reachable, skipUnless } from './test-client.js';

const STORAGE_URL = process.env.SHOPKART_STORAGE_MCP_URL || 'http://127.0.0.1:4013/mcp';

const AGENT = 'storage-invariant-tests';
const call = (url, name, args) => callTool(url, AGENT, 'storage', name, args);
const skipStorage = await skipUnless(STORAGE_URL, 'shopkart-storage', 'storage');

test('a returned storage listing is always complete', { skip: skipStorage }, async () => {
  const all = await call(STORAGE_URL, 'storage_list_objects', { prefix: 'uploads/' });
  assert.equal(all.truncated, false);
  assert.ok(all.objects.length > 1, 'fixture seeds several objects');
});

test('storage refuses an oversized listing instead of returning a partial set', { skip: skipStorage }, async () => {
  // The seeded bucket cannot overflow the default 1000-object cap, so run a
  // second adapter with the cap driven down to 1. This is the invariant that
  // matters most here: the old code returned `truncated: true` and trusted the
  // caller to notice, and a caller that does not notice plans an erasure that
  // silently leaves the subject's files in place.
  const { spawn } = await import('node:child_process');
  const port = 4113;
  const child = spawn(process.execPath, [new URL('./storage-server.js', import.meta.url).pathname], {
    env: { ...process.env, MCP_TRANSPORT: 'http', MCP_STORAGE_PORT: String(port), MCP_STORAGE_MAX_RESULTS: '1' },
    stdio: 'ignore',
  });

  try {
    const url = `http://127.0.0.1:${port}/mcp`;
    // reachable() already retries; this is the outer wait for a process that
    // has only just been spawned and may not have bound its port yet.
    for (let i = 0; i < 10 && !(await reachable(url, AGENT, 'storage')); i += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    await assert.rejects(
      call(url, 'storage_list_objects', { prefix: 'uploads/' }),
      /refusing to return a partial set/,
    );
    // A listing that fits the cap still succeeds, so the guard is a ceiling
    // rather than a blanket refusal.
    const one = await call(url, 'storage_search_objects', { query: 'return-receipt' });
    assert.equal(one.objects.length, 1);
  } finally {
    child.kill();
  }
});
