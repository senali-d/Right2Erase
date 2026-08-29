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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseResult } from '../agent/create-agent.js';

const STORAGE_URL = process.env.SHOPKART_STORAGE_MCP_URL || 'http://127.0.0.1:4013/mcp';

async function connect(url) {
  const client = new Client({ name: 'storage-invariant-tests', version: '1.0.0' });
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

async function call(url, name, args) {
  const client = await connect(url);
  try {
    return parseResult(await client.callTool({ name, arguments: args }));
  } finally {
    await client.close();
  }
}

const skipStorage = (await reachable(STORAGE_URL))
  ? false
  : `shopkart-storage MCP not reachable at ${STORAGE_URL}; run npm run dev`;

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
    for (let i = 0; i < 50 && !(await reachable(url)); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
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
