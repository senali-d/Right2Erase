#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { pathToFileURL } from 'node:url';
import { createTrueForgeAgent, MCP_SERVERS } from './trueforge-agent.js';

const serverForTool = new Map([
  ['db_', 'database'], ['storage_', 'storage'], ['billing_', 'billing'],
  ['case_', 'oubliette'], ['finding_', 'oubliette'], ['plan_', 'oubliette'],
  ['oubliette_', 'oubliette'],
]);

// An MCP tool failure comes back as a normal response with isError set and the
// message in the text content, not as a thrown transport error. Without this
// check a failed finding_add reads as a successful one, and the workflow walks
// on to plan_create over a case that is quietly missing records.
export function parseResult(result) {
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  if (result?.isError) throw new Error(text || 'MCP tool call failed');
  if (!text) return result;
  try { return JSON.parse(text); } catch { return text; }
}

// A per-server override (MCP_AUTH_TOKEN_<NAME>) wins when servers are issued
// distinct secrets; MCP_AUTH_TOKEN alone covers the common case of one shared
// token for every server. Never logged, never placed in the connection URL.
function tokenFor(name) {
  return process.env[`MCP_AUTH_TOKEN_${name.toUpperCase()}`] || process.env.MCP_AUTH_TOKEN || undefined;
}

/**
 * @typedef {object} ToolCallEvent
 * @property {string} tool
 * @property {string} server
 * @property {boolean} ok
 * @property {number} ms
 * @property {unknown} [result]
 * @property {string} [error]
 */

/**
 * onToolCall, when supplied, observes every MCP round trip the workflow makes.
 * It is the only progress signal the agent offers: trueforge-agent.js is a
 * single awaited call with no events of its own, so a caller that wants to show
 * live progress derives it from the tool names passing through here. Purely an
 * observer - it cannot alter arguments, results, or control flow, and a throw
 * from it must never fail the erasure workflow.
 *
 * @param {object} [options]
 * @param {(request: { case_id: string, plan_hash: string, approved_by: string }) => Promise<boolean>} [options.approval]
 * @param {(event: ToolCallEvent) => void} [options.onToolCall]
 */
export async function createAgent({ approval = async () => false, onToolCall } = {}) {
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

  const observe = (event) => {
    if (!onToolCall) return;
    try { onToolCall(event); } catch { /* an observer must never break the workflow */ }
  };

  const callTool = async (name, args) => {
    const prefix = [...serverForTool.keys()].find((value) => name.startsWith(value));
    const server = prefix && serverForTool.get(prefix);
    if (!server) throw new Error(`no MCP server configured for ${name}`);
    const started = Date.now();
    try {
      const value = parseResult(await clients.get(server).callTool({ name, arguments: args }));
      observe({ tool: name, server, ok: true, ms: Date.now() - started, result: value });
      return value;
    } catch (error) {
      observe({ tool: name, server, ok: false, ms: Date.now() - started, error: error.message });
      throw error;
    }
  };

  const agent = createTrueForgeAgent({ callTool, requestApproval: approval });
  return {
    ...agent,
    async close() {
      await Promise.all([...clients.values()].map((client) => client.close()));
    },
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
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
