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

/**
 * The bearer token for one server, matching how every other client here picks
 * it: a per-server MCP_AUTH_TOKEN_<NAME> if one is issued, otherwise the shared
 * MCP_AUTH_TOKEN. See agent/create-agent.js and web/lib/mcp.ts.
 *
 * TrueForge calls these servers itself rather than proxying through us, so if
 * a token is configured it has to be handed over at registration. Without it
 * the agent's own tool calls get 401s that never reach this script: the run
 * simply lists tools, finds none it can use, and stops - reporting success
 * having done nothing, which is the worst way for a credential problem to
 * present.
 */
function authFor(name) {
  const token = process.env[`MCP_AUTH_TOKEN_${name.toUpperCase()}`] || process.env.MCP_AUTH_TOKEN;
  return token ? { auth: { type: 'header', headers: { authorization: `Bearer ${token}` } } } : {};
}

// The four adapters this project serves, named as the agent definition
// references them. URLs mirror the ports in .env.example. The env var each
// token is read from is the adapter's own name, not its TrueForge label.
const MCP_SERVERS = [
  { name: 'shopkart-db', url: process.env.SHOPKART_DB_MCP_URL || 'http://127.0.0.1:4012/mcp', description: 'Read-only ShopKart Postgres discovery, sandbox snapshot export, and deletion rehearsal.', ...authFor('database') },
  { name: 'shopkart-storage', url: process.env.SHOPKART_STORAGE_MCP_URL || 'http://127.0.0.1:4013/mcp', description: 'Read-only ShopKart MinIO object metadata. Never returns object content.', ...authFor('storage') },
  { name: 'shopkart-billing', url: process.env.SHOPKART_BILLING_MCP_URL || 'http://127.0.0.1:4011/mcp', description: 'Read-only billing customer and charge lookup, plus dry-run erasure preview.', ...authFor('billing') },
  { name: 'right-to-erase', url: process.env.OUBLIETTE_MCP_URL || 'http://127.0.0.1:4014/mcp', description: 'Oubliette case management: findings, immutable plans, approvals, and the sole destructive erasure tool.', ...authFor('oubliette') },
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

/**
 * Resolve one model entry: its upstream id and the properties that go with it.
 *
 * The two must come from the same entry. A model's TrueForge name and its
 * provider id are different strings - `gpt-5-5` is the label, `gpt-5.5` is what
 * OpenAI answers to - so pairing an id from one source with properties matched
 * by name from another can describe a model that does not exist. Returning them
 * together is what makes that impossible.
 *
 * An explicit OPENAI_MODEL_ID identifies a model by its upstream id, so it is
 * matched strictly against `model_id`; a name-only lookup would otherwise be
 * free to return a different model whose label happened to match first.
 */
async function resolveModel(providerType, { name, modelId, configured }) {
  const pick = (entry) => (entry ? { modelId: entry.model_id, properties: entry.properties } : null);

  // The catalog is consulted first, even when an entry is already configured.
  // It is the provider's own statement of what a model is called upstream, so
  // deferring to whatever happens to be stored would let one bad write persist
  // through every later run - which is exactly how `gpt-5-5` ended up recorded
  // as its own model id. A configured entry is the fallback, for models the
  // catalog does not list; OPENAI_MODEL_ID is the way to override deliberately.
  let catalogModels = [];
  try {
    const response = await fetch(`${BASE}/api/v1/catalogs/model-providers`);
    if (response.ok) {
      const catalog = await response.json();
      catalogModels = (catalog.data || []).find((entry) => entry.type === providerType)?.models || [];
    }
  } catch {
    // Falls through to the configured entry, or to no match at all.
  }

  const match = modelId
    ? catalogModels.find((entry) => entry.model_id === modelId)
    : catalogModels.find((entry) => entry.name === name);
  if (match) return pick(match);

  // Nothing in the catalog. An explicitly requested id can still be honoured if
  // the provider already has an entry for exactly that id.
  if (modelId) {
    return configured?.model_id === modelId && configured?.properties ? pick(configured) : null;
  }
  return pick(configured?.model_id && configured?.properties ? configured : null);
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
    // reasoning efforts - or the write is rejected. The upstream id and those
    // properties are resolved together from one entry, never assembled from
    // two: the name is TrueForge's label and the id is what the provider
    // answers to, so defaulting one to the other writes a model that does not
    // exist upstream.
    const resolved = await resolveModel('openai', {
      name: modelName,
      modelId: process.env.OPENAI_MODEL_ID,
      configured: (existing?.manifest.models || []).find((entry) => entry.name === modelName),
    });
    if (!resolved) {
      throw new Error(
        `cannot resolve ${model}: ${process.env.OPENAI_MODEL_ID
          ? `OPENAI_MODEL_ID="${process.env.OPENAI_MODEL_ID}" is not in TrueForge's model catalog`
          : `no catalog entry named "${modelName}" and none configured`}`,
      );
    }

    // model_ids are unique within a provider, so pointing this name at an id
    // another entry already claims is a conflict the write would reject with a
    // message that does not say what to do about it. Two names for one upstream
    // model is not something to resolve by quietly dropping the other entry.
    const clash = keep.find((entry) => entry.model_id === resolved.modelId);
    if (clash) {
      throw new Error(
        `model id "${resolved.modelId}" is already configured as "${clash.name}". `
        + `Point the agent at openai/${clash.name} in agent/oubliette-agent.json `
        + 'rather than aliasing the same model under a second name.',
      );
    }

    await send('PUT', '/api/v1/settings/model-providers', {
      manifest: {
        type: 'openai',
        auth: { api_key: process.env.OPENAI_API_KEY },
        models: [...keep, { name: modelName, model_id: resolved.modelId, properties: resolved.properties }],
      },
    });
    providers = await listProviders();
    console.log(`model provider: openai key set from environment (${modelName} -> ${resolved.modelId}${
      keep.length ? `, kept ${keep.length} other model${keep.length === 1 ? '' : 's'}` : ''})`);
  } else if (names(providers).includes(model)) {
    console.log(`model provider: ${model} already configured in TrueForge (no OPENAI_API_KEY in environment)`);
  } else {
    console.warn(`\nWARNING: model ${model} is not configured, and OPENAI_API_KEY is not set.`);
    console.warn(`Configured: ${names(providers).join(', ') || '(none)'}`);
    console.warn('Put OPENAI_API_KEY in .env and re-run with --env-file=.env.');
  }

  // The agent is registered last because TrueForge validates the model its
  // manifest names against the configured providers and rejects the write with
  // a 422 if that model does not exist yet. Against a TrueForge that has been
  // used before, the provider is already there and the order does not show;
  // against a fresh one - a teammate's first run, or a container that starts
  // with empty settings on every boot - registering the agent first fails
  // every time.
  //
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

  console.log(`\nReady. Agent "${definition.name}" is available at ${BASE}.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  bootstrap().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
