#!/usr/bin/env node
/**
 * Register this project's MCP servers and erasure agent with a local TrueForge.
 *
 * Idempotent: both endpoints are upserts keyed by name, so re-running after an
 * edit to agent/oubliette-agent.json republishes the agent rather than failing.
 * Configuring a model provider is deliberately not automated - it needs an API
 * key, which belongs in TrueForge's own settings, not in a repo script.
 *
 *   node scripts/trueforge-bootstrap.mjs
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const BASE = process.env.TRUEFORGE_BASE_URL || 'http://localhost:8790';

// The four adapters this project serves, named as the agent definition
// references them. URLs mirror the ports in .env.example.
const MCP_SERVERS = [
  { name: 'shopkart-db', url: process.env.SHOPKART_DB_MCP_URL || 'http://127.0.0.1:4012/mcp', description: 'Read-only ShopKart Postgres discovery, sandbox snapshot export, and deletion rehearsal.' },
  { name: 'shopkart-storage', url: process.env.SHOPKART_STORAGE_MCP_URL || 'http://127.0.0.1:4013/mcp', description: 'Read-only ShopKart MinIO object metadata. Never returns object content.' },
  { name: 'shopkart-billing', url: process.env.SHOPKART_BILLING_MCP_URL || 'http://127.0.0.1:4011/mcp', description: 'Read-only billing customer and charge lookup, plus dry-run erasure preview.' },
  { name: 'right-to-erase', url: process.env.OUBLIETTE_MCP_URL || 'http://127.0.0.1:4014/mcp', description: 'Oubliette case management: findings, immutable plans, approvals, and the sole destructive erasure tool.' },
];

async function send(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

export async function bootstrap() {
  // Fail with a usable message rather than a bare ECONNREFUSED stack.
  try {
    await fetch(`${BASE}/api/v1/settings/mcp-servers`);
  } catch {
    throw new Error(`TrueForge is not reachable at ${BASE}. Start it with: npx @truefoundry/trueforge@latest`);
  }

  for (const server of MCP_SERVERS) {
    await send('PUT', '/api/v1/settings/mcp-servers', {
      manifest: { type: 'remote', ...server },
    });
    console.log(`mcp server: ${server.name} -> ${server.url}`);
  }

  const definition = JSON.parse(
    await readFile(new URL('../agent/oubliette-agent.json', import.meta.url), 'utf8'),
  );

  // POST creates; a 409 means the name is taken, so replace that agent's
  // manifest instead. Agents are keyed by a generated immutable agent_id, not
  // by name, so the update path has to resolve the name to an id first.
  try {
    await send('POST', '/api/v1/agents', definition);
    console.log(`agent: created ${definition.name}`);
  } catch (error) {
    if (!/-> 409:/.test(error.message)) throw error;
    const listed = await (await fetch(`${BASE}/api/v1/agents`)).json();
    const existing = (listed.data || []).find((agent) => agent.name === definition.name);
    if (!existing) throw new Error(`${definition.name} reported as taken but is not listed`);
    const agentId = existing.agent_id || existing.id;
    await send('PUT', `/api/v1/agents/${agentId}`, { manifest: definition.manifest });
    console.log(`agent: updated ${definition.name} (${agentId})`);
  }

  const model = definition.manifest.model.name;
  const providers = await (await fetch(`${BASE}/api/v1/settings/model-providers`)).json();
  const configured = (providers.data || []).flatMap(
    (provider) => (provider.manifest.models || []).map((entry) => `${provider.name}/${entry.name}`),
  );
  if (!configured.includes(model)) {
    console.warn(`\nWARNING: model ${model} is not configured in TrueForge.`);
    console.warn(`Configured: ${configured.join(', ') || '(none)'}`);
    console.warn(`Add it under Settings -> Models at ${BASE}, or edit agent/oubliette-agent.json.`);
  }

  console.log(`\nReady. Agent "${definition.name}" is available at ${BASE}.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  bootstrap().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
