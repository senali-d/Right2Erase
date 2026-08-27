#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTrueForgeAgent, MCP_SERVERS } from './trueforge-agent.js';

const serverForTool = new Map([
  ['db_', 'database'], ['storage_', 'storage'], ['billing_', 'billing'],
  ['case_', 'oubliette'], ['finding_', 'oubliette'], ['plan_', 'oubliette'],
  ['oubliette_', 'oubliette'],
]);

function parseResult(result) {
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) return result;
  try { return JSON.parse(text); } catch { return text; }
}

// A per-server override (MCP_AUTH_TOKEN_<NAME>) wins when servers are issued
// distinct secrets; MCP_AUTH_TOKEN alone covers the common case of one shared
// token for every server. Never logged, never placed in the connection URL.
function tokenFor(name) {
  return process.env[`MCP_AUTH_TOKEN_${name.toUpperCase()}`] || process.env.MCP_AUTH_TOKEN || undefined;
}

export async function createAgent({ approval = async () => false } = {}) {
  const clients = new Map();
  try {
    for (const [name, url] of Object.entries(MCP_SERVERS)) {
      const client = new Client({ name: 'trueforge-agent', version: '1.0.0' });
      clients.set(name, client);
      const token = tokenFor(name);
      const requestInit = token ? { headers: { authorization: `Bearer ${token}` } } : undefined;
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit }));
    }
  } catch (error) {
    await Promise.allSettled([...clients.values()].map((client) => client.close()));
    throw error;
  }

  const callTool = async (name, args) => {
    const prefix = [...serverForTool.keys()].find((value) => name.startsWith(value));
    const server = prefix && serverForTool.get(prefix);
    if (!server) throw new Error(`no MCP server configured for ${name}`);
    return parseResult(await clients.get(server).callTool({ name, arguments: args }));
  };

  const agent = createTrueForgeAgent({ callTool, requestApproval: approval });
  return {
    ...agent,
    async close() {
      await Promise.all([...clients.values()].map((client) => client.close()));
    },
  };
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const subject_email = process.argv[2];
  if (!subject_email) {
    console.error('Usage: node agent/create-agent.js <subject-email>');
    process.exitCode = 2;
  } else {
    const agent = await createAgent();
    try {
      const prepared = await agent.prepare({ subject_email });
      console.log(JSON.stringify(prepared, null, 2));
      console.error('Plan prepared. Obtain human approval, then call executeApproved().');
    } finally {
      await agent.close();
    }
  }
}
