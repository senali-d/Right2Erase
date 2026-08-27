import express from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function startHttpMcp(createServer, {
  name,
  port = Number(process.env.MCP_PORT || 4011),
  host = process.env.MCP_HOST || '127.0.0.1',
} = {}) {
  const app = express();
  const sessions = new Map();
  const sessionTimers = new Map();
  const pendingInitializationTransports = new Set();
  const activeRequests = new Map();
  const sessionIdleTtlMs = positiveInteger(process.env.MCP_SESSION_TTL_MS, 5 * 60 * 1000);
  const maxSessions = positiveInteger(process.env.MCP_MAX_SESSIONS, 100);
  let pendingInitializations = 0;
  let shuttingDown = false;
  const authToken = process.env.MCP_AUTH_TOKEN;
  const trustedOrigins = new Set(
    (process.env.MCP_TRUSTED_ORIGINS || `http://localhost:${port},http://127.0.0.1:${port}`)
      .split(',').map((origin) => origin.trim()).filter(Boolean),
  );
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!loopback && !authToken) throw new Error('MCP_AUTH_TOKEN is required for non-loopback HTTP');

  app.use('/mcp', (req, res, next) => {
    const origin = req.get('origin');
    if (origin && !trustedOrigins.has(origin)) return res.status(403).json({ error: 'Untrusted Origin' });
    if (authToken && req.get('authorization') !== `Bearer ${authToken}`) {
      return res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'Unauthorized' });
    }
    if (shuttingDown) return res.status(503).json({ error: 'MCP server is shutting down' });
    return next();
  });
  app.use(express.json());

  function refreshSession(id, transport) {
    if (activeRequests.has(transport)) return;

    const previousTimer = sessionTimers.get(id);
    if (previousTimer) clearTimeout(previousTimer);

    const timer = setTimeout(async () => {
      if (activeRequests.has(transport) || sessions.get(id) !== transport) return;
      sessions.delete(id);
      sessionTimers.delete(id);
      try {
        await transport.close();
      } catch (error) {
        console.error(`${name || 'MCP'} failed to close idle session ${id}:`, error);
      }
    }, sessionIdleTtlMs);
    timer.unref?.();
    sessionTimers.set(id, timer);
  }

  async function closeAllSessions() {
    const pending = [...pendingInitializationTransports];
    await Promise.allSettled(pending.map((transport) => transport.close()));

    const active = [...sessions.values()];
    await Promise.allSettled(active.map((transport) => transport.close()));
    sessions.clear();
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
        if (id && sessions.get(id) === transport) refreshSession(id, transport);
      }
    }
  }

  app.post('/mcp', async (req, res) => {
    const requested = req.headers['mcp-session-id'];
    let transport = requested ? sessions.get(requested) : undefined;
    let provisional = false;
    let initialized = false;
    let pendingInitializationReleased = false;

    const releasePendingInitialization = () => {
      if (provisional && !pendingInitializationReleased) {
        pendingInitializationReleased = true;
        pendingInitializations -= 1;
        pendingInitializationTransports.delete(transport);
      }
    };

    try {
      if (!transport && !requested && req.body?.method === 'initialize') {
        if (sessions.size + pendingInitializations >= maxSessions) {
          return res.status(503).json({ error: 'MCP session limit reached' });
        }

        pendingInitializations += 1;
        provisional = true;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            releasePendingInitialization();
            if (shuttingDown) {
              initialized = true;
              void transport.close().catch((error) => {
                console.error(`${name || 'MCP'} failed to close transport initialized during shutdown:`, error);
              });
              return;
            }
            initialized = true;
            sessions.set(id, transport);
            refreshSession(id, transport);
          },
        });
        pendingInitializationTransports.add(transport);
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id && sessions.get(id) === transport) sessions.delete(id);
          if (id && sessionTimers.has(id)) {
            clearTimeout(sessionTimers.get(id));
            sessionTimers.delete(id);
          }
        };
        await createServer().connect(transport);
      }
      if (!transport) return res.status(requested ? 404 : 400).json({
        jsonrpc: '2.0', error: { code: -32000, message: 'Invalid or missing MCP session' }, id: null,
      });
      await handleSessionRequest(transport, req, res, req.body);
    } catch (error) {
      console.error(`${name || 'MCP'} HTTP error:`, error);
      if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
    } finally {
      if (provisional) releasePendingInitialization();
      if (provisional && !initialized) await transport.close().catch(() => {});
    }
  });

  for (const method of ['get', 'delete']) {
    app[method]('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'];
      const transport = sessions.get(sessionId);
      if (!transport) return res.status(sessionId ? 404 : 400).send('Invalid or missing MCP session');
      try { await handleSessionRequest(transport, req, res); }
      catch (error) {
        console.error(`${name || 'MCP'} ${method.toUpperCase()} error:`, error);
        if (!res.headersSent) res.status(500).send('MCP request failed');
      }
    });
  }

  const httpServer = app.listen(port, host, () => {
    console.error(`${name || 'MCP'} HTTP server listening at http://${host}:${port}/mcp`);
  });
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await closeAllSessions();
    await new Promise((resolve) => httpServer.close(resolve));
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown().catch(console.error));
  return httpServer;
}
