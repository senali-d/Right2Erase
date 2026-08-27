#!/usr/bin/env node
/**
 * MCP server over the ShopKart billing API.
 *
 * This is the "bring your own MCP" piece: the agent reaches your internal
 * service the same way it reaches Postgres or GitHub, over MCP, with no
 * special-casing in the agent itself.
 *
 * The billing MCP adapter exposes discovery and dry-run preview only. Actual
 * billing deletion is deliberately owned by Oubliette's approved execution path.
 *
 *   node mcp-server.js                    # stdio transport
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { z } from 'zod';

const BASE = process.env.BILLING_URL || 'http://localhost:4010';

async function call(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`billing-api ${res.status}: ${text}`);
  return JSON.parse(text);
}

const asText = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

function createServer() {
  const server = new McpServer({ name: 'shopkart-billing', version: '1.0.0' });

server.tool(
  'billing_find_customer',
  'Find billing customers by exact email address. Returns zero or more matches. '
  + 'Search every known address for the subject, including historical ones.',
  { email: z.string().email().describe('exact email address to look up') },
  async ({ email }) => asText(await call(`/customers?email=${encodeURIComponent(email)}`)),
);

server.tool(
  'billing_get_customer',
  'Fetch one billing customer: name, email and saved payment profile.',
  { customer_id: z.string().describe('billing customer id, e.g. cus_00042') },
  async ({ customer_id }) => asText(await call(`/customers/${encodeURIComponent(customer_id)}`)),
);

server.tool(
  'billing_list_charges',
  'List the charge history for a billing customer.',
  { customer_id: z.string() },
  async ({ customer_id }) => asText(await call(`/customers/${encodeURIComponent(customer_id)}/charges`)),
);

server.tool(
  'billing_preview_erase',
  'Report exactly what erasing a billing customer would remove. Changes nothing. '
  + 'Always call this and include the result in the plan before requesting approval.',
  { customer_id: z.string() },
  async ({ customer_id }) => asText(
    await call(`/customers/${encodeURIComponent(customer_id)}/erase`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: true }),
    }),
  ),
);

  return server;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

let server = createServer();

if (process.env.MCP_TRANSPORT === 'http') {
  const port = Number(process.env.MCP_PORT || 4011);
  const host = process.env.MCP_HOST || '127.0.0.1';
  const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  const authToken = process.env.MCP_AUTH_TOKEN;
  const trustedOrigins = new Set(
    (process.env.MCP_TRUSTED_ORIGINS || `http://localhost:${port},http://127.0.0.1:${port}`)
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

  if (!isLoopback && !authToken) {
    throw new Error('MCP_AUTH_TOKEN is required when MCP_HOST is not loopback');
  }
  if (!isLoopback && !process.env.MCP_TRUSTED_ORIGINS) {
    throw new Error('MCP_TRUSTED_ORIGINS is required when MCP_HOST is not loopback');
  }

  const app = express();
  const transports = new Map();
  const sessionTimers = new Map();
  const pendingInitializationTransports = new Set();
  const activeRequests = new Map();
  const sessionIdleTtlMs = positiveInteger(process.env.MCP_SESSION_TTL_MS, 5 * 60 * 1000);
  const maxSessions = positiveInteger(process.env.MCP_MAX_SESSIONS, 100);
  let pendingInitializations = 0;
  let shuttingDown = false;

  function refreshSession(id, transport) {
    if (activeRequests.has(transport)) return;

    const previousTimer = sessionTimers.get(id);
    if (previousTimer) clearTimeout(previousTimer);

    const timer = setTimeout(async () => {
      if (activeRequests.has(transport) || transports.get(id) !== transport) return;
      transports.delete(id);
      sessionTimers.delete(id);
      try {
        await transport.close();
      } catch (error) {
        console.error(`Failed to close idle MCP session ${id}:`, error);
      }
    }, sessionIdleTtlMs);
    timer.unref?.();
    sessionTimers.set(id, timer);
  }

  async function closeAllSessions() {
    const pending = [...pendingInitializationTransports];
    await Promise.allSettled(pending.map((transport) => transport.close()));

    const sessions = [...transports.values()];
    await Promise.allSettled(sessions.map((transport) => transport.close()));
    transports.clear();
    for (const timer of sessionTimers.values()) clearTimeout(timer);
    sessionTimers.clear();
  }

  async function handleSessionRequest(transport, req, res, body) {
    activeRequests.set(transport, (activeRequests.get(transport) || 0) + 1);
    const previousId = transport.sessionId;
    if (previousId && sessionTimers.has(previousId)) {
      clearTimeout(sessionTimers.get(previousId));
      sessionTimers.delete(previousId);
    }

    try {
      await transport.handleRequest(req, res, body);
    } finally {
      const requestCount = activeRequests.get(transport) - 1;
      if (requestCount > 0) {
        activeRequests.set(transport, requestCount);
      } else {
        activeRequests.delete(transport);
        const id = transport.sessionId;
        if (id && transports.get(id) === transport) refreshSession(id, transport);
      }
    }
  }

  // Keep the security checks ahead of every MCP method, including session
  // creation. Requests without an Origin are allowed for non-browser MCP
  // clients; browser requests must come from an explicitly trusted origin.
  app.use('/mcp', (req, res, next) => {
    const origin = req.get('origin');
    if (origin && !trustedOrigins.has(origin)) {
      res.status(403).json({ error: 'Untrusted Origin' });
      return;
    }

    if (authToken && req.get('authorization') !== `Bearer ${authToken}`) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'Unauthorized' });
      return;
    }
    if (shuttingDown) {
      res.status(503).json({ error: 'MCP server is shutting down' });
      return;
    }
    next();
  });
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    const requestedSession = req.headers['mcp-session-id'];
    let transport = requestedSession ? transports.get(requestedSession) : undefined;
    let provisionalInitialization = false;
    let initialized = false;
    let pendingInitializationReleased = false;

    const releasePendingInitialization = () => {
      if (provisionalInitialization && !pendingInitializationReleased) {
        pendingInitializationReleased = true;
        pendingInitializations -= 1;
        pendingInitializationTransports.delete(transport);
      }
    };

    try {
      if (!transport && !requestedSession && req.body?.method === 'initialize') {
        if (transports.size + pendingInitializations >= maxSessions) {
          res.status(503).json({ error: 'MCP session limit reached' });
          return;
        }

        pendingInitializations += 1;
        provisionalInitialization = true;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            releasePendingInitialization();
            if (shuttingDown) {
              initialized = true;
              void transport.close().catch((error) => {
                console.error('Failed to close MCP transport initialized during shutdown:', error);
              });
              return;
            }
            initialized = true;
            transports.set(id, transport);
            refreshSession(id, transport);
          },
        });
        pendingInitializationTransports.add(transport);
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id && transports.get(id) === transport) transports.delete(id);
          if (id && sessionTimers.has(id)) {
            clearTimeout(sessionTimers.get(id));
            sessionTimers.delete(id);
          }
        };
        await createServer().connect(transport);
      }

      if (!transport) {
        res.status(requestedSession ? 404 : 400).json({
          jsonrpc: '2.0', error: { code: -32000, message: 'Invalid or missing MCP session' }, id: null,
        });
        return;
      }
      await handleSessionRequest(transport, req, res, req.body);
    } catch (error) {
      console.error('MCP HTTP error:', error);
      if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
    } finally {
      if (provisionalInitialization) {
        releasePendingInitialization();
        pendingInitializationTransports.delete(transport);
      }
      if (provisionalInitialization && !initialized) {
        try {
          await transport.close();
        } catch (error) {
          console.error('Failed to close unsuccessful MCP initialization:', error);
        }
      }
    }
  });

  for (const method of ['get', 'delete']) {
    app[method]('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'];
      const transport = transports.get(sessionId);
      if (!transport) {
        res.status(sessionId ? 404 : 400).send('Invalid or missing MCP session');
        return;
      }
      try {
        await handleSessionRequest(transport, req, res);
      } catch (error) {
        console.error(`MCP ${method.toUpperCase()} error:`, error);
        if (!res.headersSent) res.status(500).send('MCP request failed');
      }
    });
  }

  const httpServer = app.listen(port, host, () => {
    console.error(`Billing MCP HTTP server listening at http://${host}:${port}/mcp`);
  });

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await closeAllSessions();
    await new Promise((resolve) => httpServer.close(resolve));
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => shutdown().catch((error) => {
      console.error('MCP shutdown error:', error);
      process.exitCode = 1;
    }));
  }
} else {
  await server.connect(new StdioServerTransport());
}
