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
import { z } from 'zod';
import { startHttpMcp } from './http-transport.js';

const BASE = process.env.BILLING_URL || 'http://localhost:4010';

async function call(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`billing-api ${res.status}: ${text}`);
  return JSON.parse(text);
}

const asText = (obj) => ({
  content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
});

function createServer() {
  const server = new McpServer({ name: 'shopkart-billing', version: '1.0.0' });

  server.tool(
    'billing_find_customer',
    'Find billing customers by exact email address. Returns zero or more matches. ' +
      'Search every known address for the subject, including historical ones.',
    { email: z.string().email().describe('exact email address to look up') },
    async ({ email }) =>
      asText(await call(`/customers?email=${encodeURIComponent(email)}`)),
  );

  server.tool(
    'billing_get_customer',
    'Fetch one billing customer: name, email and saved payment profile.',
    { customer_id: z.string().describe('billing customer id, e.g. cus_00042') },
    async ({ customer_id }) =>
      asText(await call(`/customers/${encodeURIComponent(customer_id)}`)),
  );

  server.tool(
    'billing_list_charges',
    'List the charge history for a billing customer.',
    { customer_id: z.string() },
    async ({ customer_id }) =>
      asText(
        await call(`/customers/${encodeURIComponent(customer_id)}/charges`),
      ),
  );

  server.tool(
    'billing_preview_erase',
    'Report exactly what erasing a billing customer would remove. Changes nothing. ' +
      'Always call this and include the result in the plan before requesting approval.',
    { customer_id: z.string() },
    async ({ customer_id }) =>
      asText(
        await call(`/customers/${encodeURIComponent(customer_id)}/erase`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dry_run: true }),
        }),
      ),
  );

  return server;
}

if (process.env.MCP_TRANSPORT === 'http') {
  const host = process.env.MCP_HOST || '127.0.0.1';
  const isLoopback =
    host === '127.0.0.1' || host === '::1' || host === 'localhost';

  // startHttpMcp already requires MCP_AUTH_TOKEN off loopback; the billing
  // adapter additionally requires an explicit trusted-origin allowlist there,
  // since it is the one MCP server fronting a paid-billing surface.
  if (!isLoopback && !process.env.MCP_TRUSTED_ORIGINS) {
    throw new Error(
      'MCP_TRUSTED_ORIGINS is required when MCP_HOST is not loopback',
    );
  }

  startHttpMcp(createServer, {
    name: 'shopkart-billing',
    port: Number(process.env.MCP_PORT || 4011),
    host,
  });
} else {
  await createServer().connect(new StdioServerTransport());
}
