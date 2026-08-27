import express from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export function startHttpMcp(createServer, {
  name,
  port = Number(process.env.MCP_PORT || 4011),
  host = process.env.MCP_HOST || '127.0.0.1',
} = {}) {
  const app = express();
  const sessions = new Map();
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
    return next();
  });
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    const requested = req.headers['mcp-session-id'];
    let transport = requested ? sessions.get(requested) : undefined;
    let provisional = false;
    let initialized = false;
    try {
      if (!transport && !requested && req.body?.method === 'initialize') {
        provisional = true;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { initialized = true; sessions.set(id, transport); },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await createServer().connect(transport);
      }
      if (!transport) return res.status(requested ? 404 : 400).json({
        jsonrpc: '2.0', error: { code: -32000, message: 'Invalid or missing MCP session' }, id: null,
      });
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(`${name || 'MCP'} HTTP error:`, error);
      if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
    } finally {
      if (provisional && !initialized) await transport.close().catch(() => {});
    }
  });

  for (const method of ['get', 'delete']) {
    app[method]('/mcp', async (req, res) => {
      const transport = sessions.get(req.headers['mcp-session-id']);
      if (!transport) return res.status(400).send('Invalid or missing MCP session');
      try { await transport.handleRequest(req, res); }
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
    await Promise.allSettled([...sessions.values()].map((transport) => transport.close()));
    await new Promise((resolve) => httpServer.close(resolve));
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown().catch(console.error));
  return httpServer;
}
