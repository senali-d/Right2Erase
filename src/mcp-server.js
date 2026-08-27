#!/usr/bin/env node
/**
 * Oubliette's durable case-management MCP server.
 *
 * This service stores discovery, review and audit state. It intentionally does
 * not connect to ShopKart and exposes no source-system delete operation.
 */
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { startHttpMcp } from '../mcp/http-transport.js';
import { addFinding, close, createCase, getCase, listCases, recordApproval, savePlan } from './db.js';
import { executeCertificate } from './erasure.js';
import { buildPlan, hashPlan } from './plan.js';

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const caseId = z.string().min(1).max(200);
const finding = {
  system: z.string().min(1).max(100), record_type: z.string().min(1).max(100),
  record_id: z.union([z.string(), z.number()]), locator: z.string().max(1000).optional(),
  metadata: z.record(z.any()).optional(), disposition: z.enum(['erase', 'retain', 'review']).optional(),
};

function createServer() {
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
    description: 'Record a discovered personal-data record and its intended disposition.',
    inputSchema: { case_id: caseId, ...finding }, annotations: write,
  }, async ({ case_id, ...value }) => text(addFinding(case_id, value)));

  server.registerTool('plan_create', {
    description: 'Build and persist a deletion plan from findings. Returns the SHA-256 hash to review.',
    inputSchema: { case_id: caseId }, annotations: write,
  }, async ({ case_id }) => {
    const value = getCase(case_id);
    if (!value) throw new Error(`case not found: ${case_id}`);
    const body = buildPlan({ case_id, findings: value.findings });
    const planHash = hashPlan(body);
    return text({ ...savePlan(case_id, body, planHash), body, plan_hash: planHash });
  });

  server.registerTool('plan_approve', {
    description: 'Record human approval for the latest plan at the current case revision. Older plan hashes cannot be approved.',
    inputSchema: { case_id: caseId, plan_hash: z.string().length(64), approved_by: z.string().min(1).max(200), reason: z.string().max(2000).optional() }, annotations: write,
  }, async ({ case_id, plan_hash, approved_by, reason }) => text(recordApproval(case_id, plan_hash, approved_by, reason)));

  server.registerTool('certificate_record', {
    description: 'Record an execution certificate only for the latest approved plan and unchanged case revision.',
    inputSchema: { case_id: caseId, plan_hash: z.string().length(64), approved_by: z.string().min(1).max(200), manifest: z.array(z.any()).default([]), withheld: z.array(z.any()).default([]) }, annotations: write,
  }, async ({ case_id, plan_hash, approved_by, manifest, withheld }) => text(executeCertificate({ caseId: case_id, planHash: plan_hash, approvedBy: approved_by, manifest, withheld })));

  return server;
}

if (process.env.MCP_TRANSPORT === 'http') {
  startHttpMcp(createServer, { name: 'oubliette', port: Number(process.env.OUBLIETTE_MCP_PORT || process.env.MCP_PORT || 4014) });
} else {
  await createServer().connect(new StdioServerTransport());
}

process.once('SIGINT', close);
process.once('SIGTERM', close);
