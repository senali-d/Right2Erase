/**
 * Shared MCP client for the adapter test suites.
 *
 * Exists because closing an MCP client does not end its server-side session.
 * `client.close()` drops the local transport; the session stays on the server
 * until it idles out, which is 5 minutes by default (MCP_SESSION_TTL_MS), and
 * every adapter caps concurrent sessions at 100 (MCP_MAX_SESSIONS). The test
 * files open a fresh client per tool call, so one `npm test` leaves dozens of
 * live sessions behind and a few runs inside the TTL window exhaust the cap.
 *
 * What that looks like is not an error. Each suite skips itself when its
 * adapter is unreachable - so `npm test` passes on a fresh clone with no stack
 * up - and a session-limit rejection is indistinguishable from an absent
 * server. The run stays green and simply stops testing anything: 79 passing
 * quietly became 73 passing, 0 failing, with nothing to indicate that a
 * file's worth of invariants had gone unchecked.
 *
 * So `call` terminates the session it opened. terminateSession() sends the
 * DELETE that close() does not, and the server reclaims the slot immediately
 * rather than five minutes later.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseResult } from '../agent/create-agent.js';

/**
 * The bearer token the adapters expect, if one is configured.
 *
 * Without this, setting MCP_AUTH_TOKEN reproduces exactly the failure this
 * file was written to stop. Every probe gets a 401, a 401 is indistinguishable
 * from an absent server, and skipUnless skips the suite: 91 passing becomes 72
 * passing, 0 failing, with 19 adapter invariants quietly unchecked. The token
 * makes the run notice the adapters are there.
 *
 * Same precedence as the other clients in this repo - a per-server
 * MCP_AUTH_TOKEN_<NAME> if one is issued, otherwise the shared token. See
 * agent/create-agent.js and web/lib/mcp.ts.
 */
function authHeaders(name) {
  const token = process.env[`MCP_AUTH_TOKEN_${String(name).toUpperCase()}`] || process.env.MCP_AUTH_TOKEN;
  return token ? { headers: { authorization: `Bearer ${token}` } } : undefined;
}

/** Open a client, run `body` with it, and always give the session back. */
export async function withClient(url, name, body) {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: authHeaders(name) });
  const client = new Client({ name, version: '1.0.0' });
  try {
    await client.connect(transport);
    return await body(client);
  } finally {
    // Order matters: terminateSession needs a live transport to send DELETE on.
    // Neither failure is worth failing a test over - the session idles out.
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

/** Call one tool over its own session, returning the parsed result. */
export const callTool = (url, name, toolName, args) => withClient(
  url,
  name,
  async (client) => parseResult(await client.callTool({ name: toolName, arguments: args })),
);

const ATTEMPTS = 5;
const DELAY_MS = 250;

/**
 * Is this adapter up? Retries, because `npm test` runs six files at once and a
 * busy adapter must not be mistaken for an absent one. Retrying cannot make an
 * absent server present; it only stops load from silently deleting coverage.
 */
export async function reachable(url, name) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      await withClient(url, name, () => {});
      return true;
    } catch (error) {
      if (attempt === ATTEMPTS) {
        console.error(`MCP probe: ${url} unreachable after ${ATTEMPTS} attempts (${error.message})`);
        return false;
      }
      await new Promise((resolve) => { setTimeout(resolve, DELAY_MS * attempt); });
    }
  }
  return false;
}

/** Skip reason for a suite whose adapter is down, or false to run it. */
export async function skipUnless(url, name) {
  if (await reachable(url, name)) return false;
  const reason = `${name} MCP not reachable at ${url}; run npm run dev`;
  console.error(`SKIPPING suite: ${reason}`);
  return reason;
}
