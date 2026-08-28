#!/usr/bin/env node
/**
 * Translates a case's Oubliette findings into the plan.json shape
 * `fixture/scripts/truth.js --diff` expects: a closed-set delete manifest
 * plus a withhold list identified by (table, id).
 *
 * This is operator/test tooling, like truth.js itself - it reads back what
 * the agent already decided (system/record_type/disposition on each
 * finding) and buckets it. It contains no subject-specific logic: the same
 * mapping applies to any case built by the TrueForge agent.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFile } from 'node:fs/promises';
import { MCP_SERVERS } from './trueforge-agent.js';

// Postgres/billing record types truth.js scores by count. Anything else
// (account_email, minio objects) is a real deletion target the agent still
// acts on, but is outside this checker's closed key set by design.
const DELETE_KEY_BY_RECORD_TYPE = {
  account: 'accounts',
  order: 'orders',
  order_item: 'order_items',
  refund: 'refunds_settled',
  support_ticket: 'support_tickets',
  event: 'event_log',
  customer: 'billing_customers',
};

function parseResult(result) {
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) return result;
  try { return JSON.parse(text); } catch { return text; }
}

function buildManifest(findings) {
  const delete_ = {};
  const bump = (key) => { delete_[key] = (delete_[key] || 0) + 1; };
  const withhold = [];

  for (const finding of findings) {
    if (finding.disposition === 'retain') {
      if (finding.record_type !== 'retained_refund') continue;
      const row = finding.metadata?.row || {};
      withhold.push({
        table: 'retained_refunds',
        id: row.id ?? finding.record_id,
        order: row.source_order_number,
        amount_cents: row.amount_cents,
        reason: `retention: ${row.reason}`,
      });
      continue;
    }
    if (finding.disposition !== 'erase') continue;

    if (finding.record_type === 'upload') {
      const linked = finding.metadata?.row?.account_id != null;
      bump(linked ? 'uploads_linked' : 'uploads_orphaned');
      continue;
    }
    const key = DELETE_KEY_BY_RECORD_TYPE[finding.record_type];
    if (key) bump(key);
  }

  return { delete: delete_, withhold };
}

async function main() {
  const caseId = process.argv[2];
  const outPath = process.argv[3] || 'plan.json';
  if (!caseId) {
    console.error('Usage: node agent/build-plan-manifest.js <case_id> [outfile]');
    process.exitCode = 2;
    return;
  }

  const client = new Client({ name: 'plan-manifest-builder', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_SERVERS.oubliette)));
  try {
    const caseRecord = parseResult(await client.callTool({ name: 'case_get', arguments: { case_id: caseId } }));
    const manifest = buildManifest(caseRecord.findings || []);
    await writeFile(outPath, JSON.stringify(manifest, null, 2));
    console.log(`wrote ${outPath}`);
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    await client.close();
  }
}

await main();
