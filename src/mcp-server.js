#!/usr/bin/env node
/**
 * Oubliette's durable case-management MCP server.
 *
 * This service stores discovery, review and audit state. It intentionally does
 * not connect to ShopKart and exposes no source-system delete operation.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { startHttpMcp } from '../mcp/http-transport.js';
import { ALWAYS_RETAIN_RECORD_TYPES, addFinding, addFindings, close, completeDiscovery, createCase, getCase, listCases, recordApproval, savePlan } from './db.js';
import { executeBillingCleanup } from './billing-executor.js';
import { oublietteExecuteErasure } from './execution.js';
import { createSandboxMinioClient, executeSandboxMinioDeletion } from './minio-executor.js';
import { createPostgresExecutor, normalizePostgresRecordType } from './postgres-executor.js';
import { buildPlan, hashPlan } from './plan.js';

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const caseId = z.string().min(1).max(200);
/**
 * The finding vocabulary is a closed set, not free text.
 *
 * These strings are load-bearing downstream: `system` decides which executor a
 * record is routed to, `record_type` decides which table it is deleted from,
 * and the retention rule that protects retained refunds matches on
 * `record_type` exactly. When the field was free text, a caller naming things
 * its own way (`shopkart-db` for the server it queried, plural table names for
 * record types) produced a case that looked complete, planned cleanly, and
 * would have failed or misrouted at execution - with the retention rule
 * silently not matching, which is the one failure that must never be silent.
 *
 * Constraining the schema turns "use these names" from an instruction a caller
 * can drift from into a contract it cannot express anything else in.
 */
const SYSTEMS = ['postgres', 'minio', 'billing'];
const RECORD_TYPES = [
  // postgres
  'account', 'account_email', 'order', 'order_item', 'refund', 'retained_refund', 'support_ticket', 'upload', 'event',
  // minio
  'object',
  // billing
  'customer',
];

const finding = {
  system: z.enum(SYSTEMS).describe('Which source system holds the record: postgres, minio, or billing. Name the system, not the tool or server you found it through.'),
  record_type: z.enum(RECORD_TYPES).describe('What kind of record this is, singular: account, account_email, order, order_item, refund, retained_refund, support_ticket, upload, event (postgres); object (minio); customer (billing).'),
  record_id: z.union([z.string(), z.number()]).describe('The record primary key, or the object key for a minio object.'),
  locator: z.string().max(1000).optional().describe('For minio objects, the full object key.'),
  metadata: z.record(z.any()).optional().describe('The source row, kept for the audit trail. Pass the row as you received it - its own columns at the top level. A row nested under a "row" key is also accepted, and for an upload the account_id column is what separates a linked object from an orphaned one, so keep it.'),
  disposition: z.enum(['erase', 'retain', 'review']).optional().describe('erase by default. retained_refund records are always recorded as retain regardless of what is passed.'),
};

async function eraseBillingCustomer({ customerId, caseId, planHash }) {
  const base = process.env.BILLING_URL || 'http://localhost:4010';
  const response = await fetch(`${base}/customers/${encodeURIComponent(customerId)}/erase`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dry_run: false, case_id: caseId, plan_hash: planHash }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`billing-api ${response.status}: ${body}`);
  try { return JSON.parse(body); } catch { return body; }
}

/** Build the production adapters used by the destructive MCP tool. */
export function createRealExecutionInterfaces({
  postgresExecutor,
  minioClient,
  billingErase = eraseBillingCustomer,
  bucket = process.env.MINIO_BUCKET || 'shopkart-uploads',
} = {}) {
  // Do not construct or validate destructive connectors until their phase is
  // actually requested. Case-management tools can safely use the default
  // interface set in production without touching sandbox configuration.
  const getPostgresExecutor = () => {
    if (postgresExecutor === undefined) postgresExecutor = createPostgresExecutor();
    return postgresExecutor;
  };
  const getMinioClient = () => {
    if (minioClient === undefined) {
      minioClient = createSandboxMinioClient();
    }
    return minioClient;
  };

  return Object.freeze({
    database: ({ plan, case_id, actions, withheld }) => getPostgresExecutor().execute({
      ...(plan || { case_id, actions }),
      withhold: (withheld || []).map((record) => ({
        ...record,
        table: normalizePostgresRecordType(record?.record_type ?? record?.table),
        id: record?.record_id ?? record?.id,
      })),
    }),
    minio: ({ plan, planHash, plan_hash, approval, postgresPhase, withheld }) => executeSandboxMinioDeletion({
      plan, planHash: planHash || plan_hash, approval, postgresPhase,
      client: getMinioClient(), bucket, withheld,
    }),
    billing: async ({ plan, caseId, case_id, planHash, plan_hash, approvedBy, approved_by, approval, postgresPhase }) => {
      const result = await executeBillingCleanup({
        caseId: caseId || case_id,
        planHash: planHash || plan_hash,
        approvedBy: approvedBy || approved_by,
        loadContext: () => ({ plan, approval }),
        // PostgreSQL is committed by the database phase before this adapter is
        // reached. This callback records that fact without repeating deletes.
        postgresTransaction: async () => ({ manifest: postgresPhase?.result?.manifest || [] }),
        billingErase,
      });
      if (!result.ok) throw new Error(result.error || 'billing execution failed');
      return result;
    },
  });
}

const defaultExecutionInterfaces = createRealExecutionInterfaces();

export function createServer({ interfaces = defaultExecutionInterfaces } = {}) {
  const server = new McpServer({ name: 'oubliette', version: '1.0.0' });
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool('case_create', {
    description: 'Create an erasure case for one precisely identified subject.',
    inputSchema: { subject_email: z.string().email(), subject_name: z.string().max(200).optional() }, annotations: write,
  }, async (input) => text(createCase({ id: randomUUID(), ...input })));

  server.registerTool('case_get', {
    description: 'Read a complete case including findings, plans, approvals and certificate.',
    inputSchema: { case_id: caseId }, annotations: readOnly,
  }, async ({ case_id }) => {
    const value = getCase(case_id);
    if (!value) throw new Error(`case not found: ${case_id}`);
    return text(value);
  });

  server.registerTool('case_list', {
    description: 'List erasure cases, optionally filtered by lifecycle status.',
    inputSchema: { status: z.enum(['discovered', 'planned', 'approved', 'executing', 'completed', 'failed']).optional() }, annotations: readOnly,
  }, async ({ status }) => text(listCases(status)));

  server.registerTool('finding_add', {
    description: 'Record a discovered personal-data record and its intended disposition. Terminal cases cannot be mutated.',
    inputSchema: { case_id: caseId, ...finding }, annotations: write,
  }, async ({ case_id, ...value }) => text(addFinding(case_id, value)));

  server.registerTool('finding_add_many', {
    description: 'Record many discovered records in one call. Prefer this over repeated finding_add: a real subject has hundreds of records, and recording a whole query result in one call is how an investigation stays exhaustive. All findings are inserted in a single transaction, so the batch either lands whole or not at all. Terminal cases cannot be mutated.\n\nTwo forms. Use record_ids with a shared system/record_type/disposition when a whole result set is the same kind of record - hundreds of event-log ids, for example - so the batch is a list of ids rather than a list of repeated objects. Use findings when the rows differ or when each needs its own metadata. Supply exactly one of the two.',
    inputSchema: {
      case_id: caseId,
      findings: z.array(z.object(finding)).min(1).max(2000).optional()
        .describe('Full findings, one object per record. Use when the records differ or carry metadata.'),
      record_ids: z.array(z.union([z.string(), z.number()])).min(1).max(2000).optional()
        .describe('Compact form: many record ids that share one system, record_type, and disposition. Requires system and record_type.'),
      system: finding.system.optional().describe('System for every id in record_ids.'),
      record_type: finding.record_type.optional().describe('Record type for every id in record_ids.'),
      disposition: finding.disposition.describe('Disposition for every id in record_ids. erase by default.'),
    },
    annotations: write,
  }, async ({
    case_id, findings, record_ids, system, record_type, disposition,
  }) => {
    if ((findings == null) === (record_ids == null)) {
      throw new Error('pass exactly one of findings or record_ids');
    }
    const batch = findings ?? (() => {
      if (!system || !record_type) throw new Error('record_ids requires system and record_type');
      return record_ids.map((record_id) => ({ system, record_type, record_id, disposition }));
    })();
    return text(addFindings(case_id, batch));
  });

  server.registerTool('case_complete_discovery', {
    description: 'Mark discovery complete for a case. Call this only after every discovery finding for the case has been recorded; plan_create refuses to build a plan until this has been called for the case\'s current findings, so an investigation that aborts partway (for example on a truncated storage query) can never be planned or executed from its partial findings.',
    inputSchema: { case_id: caseId }, annotations: write,
  }, async ({ case_id }) => text(completeDiscovery(case_id)));

  server.registerTool('plan_create', {
    description: 'Build and persist a deletion plan from the current findings. Requires case_complete_discovery to have been called for the case\'s current findings. Concurrent case changes cause plan creation to fail; returns the SHA-256 hash to review.',
    inputSchema: { case_id: caseId }, annotations: write,
  }, async ({ case_id }) => {
    const value = getCase(case_id);
    if (!value) throw new Error(`case not found: ${case_id}`);
    if (!value.discovery_completed_at) {
      throw new Error(`case ${case_id} has not completed discovery; refusing to plan from a possibly-partial investigation`);
    }
    const body = buildPlan({ case_id, findings: value.findings });
    // addFinding already coerces these to 'retain', so this can only fire if a
    // finding reached the store by some other path. It is here because a plan
    // is an audit record a human signs: it must never claim a retained refund
    // will be deleted, even in a case where the executor would refuse anyway.
    const wrongful = body.actions.filter(
      (action) => ALWAYS_RETAIN_RECORD_TYPES.has(action.record_type) && action.disposition === 'erase',
    );
    if (wrongful.length) {
      throw new Error(`refusing to plan deletion of retained record(s): ${
        wrongful.map((a) => `${a.record_type}:${a.record_id}`).join(', ')}`);
    }
    const planHash = hashPlan(body);
    return text({ ...savePlan(case_id, body, planHash, value.revision), body, plan_hash: planHash });
  });

  server.registerTool('plan_approve', {
    description: 'Record human approval for the latest plan at the current case revision. Terminal cases cannot be mutated and older plan hashes cannot be approved.',
    inputSchema: { case_id: caseId, plan_hash: z.string().length(64), approved_by: z.string().min(1).max(200), reason: z.string().max(2000).optional() }, annotations: write,
  }, async ({ case_id, plan_hash, approved_by, reason }) => text(recordApproval(case_id, plan_hash, approved_by, reason)));

  server.registerTool('oubliette_execute_erasure', {
    description: 'The sole Oubliette-owned destructive entry point. Validates the current canonical, approved plan and executes its erase actions through the configured database, MinIO, and billing interfaces. Retain/review actions are withheld and included in the immutable certificate.',
    inputSchema: {
      case_id: caseId,
      plan_hash: z.string().length(64),
      // Optional, and you are not expected to supply it. The human approval
      // already recorded for this plan is what authorises execution and what
      // the certificate attributes it to. Passing a name only asserts a belief
      // about who approved; if it disagrees with the recorded approval the
      // execution is refused. Naming an approver you were not told is how an
      // audit trail ends up crediting an identity nobody chose.
      approved_by: z.string().min(1).max(200).optional(),
    }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ case_id, plan_hash, approved_by }) => text(await oublietteExecuteErasure({
    caseId: case_id, planHash: plan_hash, approvedBy: approved_by, interfaces,
  })));

  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.env.MCP_TRANSPORT === 'http') {
    startHttpMcp(createServer, { name: 'oubliette', port: Number(process.env.OUBLIETTE_MCP_PORT || process.env.MCP_PORT || 4014) });
  } else {
    await createServer().connect(new StdioServerTransport());
  }

  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
