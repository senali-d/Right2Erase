#!/usr/bin/env node
/**
 * Oubliette's durable case-management MCP server.
 *
 * This service stores discovery, review and audit state. It intentionally does
 * not connect to ShopKart and exposes no source-system delete operation.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as Minio from 'minio';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { startHttpMcp } from '../mcp/http-transport.js';
import { addFinding, close, createCase, getCase, listCases, recordApproval, savePlan } from './db.js';
import { executeBillingCleanup } from './billing-executor.js';
import { oublietteExecuteErasure } from './execution.js';
import { executeSandboxMinioDeletion } from './minio-executor.js';
import { createPostgresExecutor, normalizePostgresRecordType } from './postgres-executor.js';
import { buildPlan, hashPlan } from './plan.js';

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const caseId = z.string().min(1).max(200);
const finding = {
  system: z.string().min(1).max(100), record_type: z.string().min(1).max(100),
  record_id: z.union([z.string(), z.number()]), locator: z.string().max(1000).optional(),
  metadata: z.record(z.any()).optional(), disposition: z.enum(['erase', 'retain', 'review']).optional(),
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
      minioClient = new Minio.Client({
        endPoint: process.env.MINIO_HOST || 'localhost',
        port: Number(process.env.MINIO_PORT || 9000),
        useSSL: process.env.MINIO_USE_SSL === 'true',
        accessKey: process.env.MINIO_ACCESS_KEY || 'shopkart',
        secretKey: process.env.MINIO_SECRET_KEY || 'shopkart123',
      });
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

  server.registerTool('plan_create', {
    description: 'Build and persist a deletion plan from the current findings. Concurrent case changes cause plan creation to fail; returns the SHA-256 hash to review.',
    inputSchema: { case_id: caseId }, annotations: write,
  }, async ({ case_id }) => {
    const value = getCase(case_id);
    if (!value) throw new Error(`case not found: ${case_id}`);
    const body = buildPlan({ case_id, findings: value.findings });
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
      approved_by: z.string().min(1).max(200),
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
