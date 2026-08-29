#!/usr/bin/env node
/**
 * Start all four MCP servers in one Node process.
 *
 * `npm run dev` gives each server its own process, which is the right shape on
 * a laptop: a crash is isolated and the logs stay readable. In a container with
 * a hard memory ceiling it is the wrong trade - four idle V8 heaps cost around
 * 140 MB of the budget for nothing. This module buys that back.
 *
 * Nothing here reimplements a server. The three ShopKart adapters already start
 * themselves on import when MCP_TRANSPORT is 'http' (see the trailing block in
 * each), so importing them is enough. src/mcp-server.js guards its own start on
 * being the entry module, so its exported factory is handed to startHttpMcp
 * directly.
 *
 * The ports must be set explicitly. Each server falls back to MCP_PORT when its
 * own variable is unset, so a lone MCP_PORT=4011 would put the database server
 * on billing's port and the second bind would fail.
 */
process.env.MCP_TRANSPORT = 'http';

const ports = {
  billing: process.env.MCP_PORT || '4011',
  database: process.env.MCP_DB_PORT || '4012',
  storage: process.env.MCP_STORAGE_PORT || '4013',
  oubliette: process.env.OUBLIETTE_MCP_PORT || '4014',
};
const distinct = new Set(Object.values(ports));
if (distinct.size !== Object.keys(ports).length) {
  throw new Error(`each MCP server needs its own port, got ${JSON.stringify(ports)}`);
}
process.env.MCP_PORT = ports.billing;
process.env.MCP_DB_PORT = ports.database;
process.env.MCP_STORAGE_PORT = ports.storage;
process.env.OUBLIETTE_MCP_PORT = ports.oubliette;

// Sequential, not Promise.all: each import binds a listener, and a port
// conflict is far easier to read when only one server is starting at a time.
await import('../mcp/billing-server.js');
await import('../mcp/database-server.js');
await import('../mcp/storage-server.js');

const { createServer } = await import('../src/mcp-server.js');
const { startHttpMcp } = await import('../mcp/http-transport.js');
startHttpMcp(createServer, { name: 'oubliette', port: Number(ports.oubliette) });
