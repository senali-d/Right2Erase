#!/usr/bin/env node
/**
 * Register this project's MCP servers and erasure agent with a local TrueForge.
 *
 * Idempotent: every endpoint is an upsert keyed by name, so re-running after an
 * edit to agent/oubliette-agent.json republishes the agent rather than failing.
 *
 *   node --env-file=.env scripts/trueforge-bootstrap.mjs
 *
 * The model provider is registered only when OPENAI_API_KEY is present. The key
 * is read from the environment and sent straight to TrueForge, which stores it
 * in its own settings - it is never written to a file in this repo, and .env is
 * gitignored. Without the variable the script still registers the MCP servers
 * and the agent, and tells you the provider is missing.
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

/** The provider's own declared limits for a model, from TrueForge's catalog. */
async function catalogProperties(providerType, modelId, modelName) {
  try {
    const response = await fetch(`${BASE}/api/v1/catalogs/model-providers`);
    if (!response.ok) return null;
    const catalog = await response.json();
    const provider = (catalog.data || []).find((entry) => entry.type === providerType);
    const match = (provider?.models || []).find(
      (entry) => entry.model_id === modelId || entry.name === modelName,
    );
    return match?.properties ?? null;
  } catch {
    return null;
  }
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
  const [providerType, modelName] = model.split('/');

  const listProviders = async () => (await (await fetch(`${BASE}/api/v1/settings/model-providers`)).json()).data || [];
  const names = (providers) => providers.flatMap(
    (provider) => (provider.manifest.models || []).map((entry) => `${provider.name}/${entry.name}`),
  );

  let providers = await listProviders();

  // A key in the environment is authoritative: it is written every time, so
  // .env can rotate a credential and not merely create one. That matters
  // because otherwise a stale key configured through the TrueForge UI could
  // only ever be replaced through that same UI.
  //
  // The endpoint replaces a provider wholesale, so the existing model list is
  // read back and merged rather than overwritten - rotating a key must not
  // silently delete models someone configured by hand. When no key is present
  // nothing is written at all: re-sending the redacted key the API hands back
  // is not worth risking against a working credential.
  if (providerType === 'openai' && process.env.OPENAI_API_KEY) {
    const existing = providers.find((provider) => provider.name === 'openai');
    const keep = (existing?.manifest.models || []).filter((entry) => entry.name !== modelName);

    // Every model entry must carry `properties` - context length, output cap,
    // reasoning efforts - or the write is rejected. Take them from the entry
    // already configured, else from TrueForge's own catalog, so the values are
    // the provider's rather than something guessed here.
    const modelId = process.env.OPENAI_MODEL_ID || modelName;
    const configured = (existing?.manifest.models || []).find((entry) => entry.name === modelName);
    const properties = configured?.properties ?? (await catalogProperties('openai', modelId, modelName));
    if (!properties) {
      throw new Error(`${model} is not in TrueForge's model catalog and has no configured properties; set OPENAI_MODEL_ID to a catalog model id`);
    }

    await send('PUT', '/api/v1/settings/model-providers', {
      manifest: {
        type: 'openai',
        auth: { api_key: process.env.OPENAI_API_KEY },
        models: [...keep, { name: modelName, model_id: modelId, properties }],
      },
    });
    providers = await listProviders();
    console.log(`model provider: openai key set from environment (${modelName}${
      keep.length ? `, kept ${keep.length} other model${keep.length === 1 ? '' : 's'}` : ''})`);
  } else if (names(providers).includes(model)) {
    console.log(`model provider: ${model} already configured in TrueForge (no OPENAI_API_KEY in environment)`);
  } else {
    console.warn(`\nWARNING: model ${model} is not configured, and OPENAI_API_KEY is not set.`);
    console.warn(`Configured: ${names(providers).join(', ') || '(none)'}`);
    console.warn('Put OPENAI_API_KEY in .env and re-run with --env-file=.env.');
  }

  console.log(`\nReady. Agent "${definition.name}" is available at ${BASE}.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  bootstrap().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
