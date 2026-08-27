#!/usr/bin/env node
/**
 * MCP server over the ShopKart billing API.
 *
 * This is the "bring your own MCP" piece: the agent reaches your internal
 * service the same way it reaches Postgres or GitHub, over MCP, with no
 * special-casing in the agent itself.
 *
 * Note the split between read tools and billing_erase_customer. Point your
 * TrueForge approval policy at that one tool name — it is the only thing here
 * that cannot be undone.
 *
 *   node mcp-server.js                    # stdio transport
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = process.env.BILLING_URL || 'http://localhost:4010';

async function call(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`billing-api ${res.status}: ${text}`);
  return JSON.parse(text);
}

const asText = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

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

server.tool(
  'billing_erase_customer',
  'IRREVERSIBLE. Permanently destroys a billing customer record, their saved '
  + 'payment profile and their charge history. Requires human approval. Must be '
  + 'called with the plan_hash that was approved; execution is recorded in the audit log.',
  {
    customer_id: z.string(),
    case_id: z.string().describe('erasure case identifier'),
    plan_hash: z.string().describe('hash of the approved plan; recorded for audit'),
  },
  async ({ customer_id, case_id, plan_hash }) => asText(
    await call(`/customers/${encodeURIComponent(customer_id)}/erase`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: false, case_id, plan_hash }),
    }),
  ),
);

await server.connect(new StdioServerTransport());
