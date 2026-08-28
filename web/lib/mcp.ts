import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCP_SERVERS } from '../../agent/trueforge-agent.js';
import { parseResult } from '../../agent/create-agent.js';

/**
 * Read-only Oubliette access for the UI.
 *
 * This exists because createAgent() does not expose its callTool, and building
 * a whole agent just to read a case would open four MCP sessions to answer one
 * question. It reaches only case_get / case_list - both annotated readOnlyHint
 * - and must never be given a write or execute tool: every mutation belongs on
 * the agent path, where Oubliette's approval and hash checks apply.
 *
 * Server-side only. mcp/http-transport.js enforces an Origin allowlist and
 * serves no CORS headers, so a browser calling this directly would be refused.
 */

function tokenFor(name: string): string | undefined {
  return process.env[`MCP_AUTH_TOKEN_${name.toUpperCase()}`] || process.env.MCP_AUTH_TOKEN || undefined;
}

async function withOublietteClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'oubliette-web', version: '1.0.0' });
  const token = tokenFor('oubliette');
  const requestInit = token ? { headers: { authorization: `Bearer ${token}` } } : undefined;
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_SERVERS.oubliette), { requestInit }));
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function readTool(name: 'case_get' | 'case_list', args: Record<string, unknown>) {
  return withOublietteClient(async (client) =>
    parseResult(await client.callTool({ name, arguments: args })));
}

export type CaseSummary = {
  id: string;
  subject_email: string;
  subject_name: string | null;
  status: 'discovered' | 'planned' | 'approved' | 'executing' | 'completed' | 'failed';
  created_at: string;
  updated_at: string;
  revision: number;
  discovery_completed_at: string | null;
  finding_count: number;
};

export type Finding = {
  id: number;
  case_id: string;
  system: string;
  record_type: string;
  record_id: string;
  locator: string | null;
  metadata: { row?: Record<string, unknown>; [key: string]: unknown };
  disposition: 'erase' | 'retain' | 'review';
  created_at: string;
};

export type PlanAction = {
  system: string;
  record_type: string;
  record_id: string | number;
  locator: string | null;
  disposition: 'erase' | 'retain' | 'review';
};

export type PlanRow = {
  id: number;
  case_id: string;
  version: number;
  plan_hash: string;
  case_revision: number;
  created_at: string;
  body: { case_id: string; actions: PlanAction[]; generated_at: string };
};

export type Approval = {
  id: number;
  case_id: string;
  plan_hash: string;
  case_revision: number;
  approved_by: string;
  reason: string | null;
  approved_at: string;
};

export type Certificate = {
  id: number;
  case_id: string;
  plan_hash: string;
  approved_by: string;
  manifest: PlanAction[];
  withheld: PlanAction[];
  executed_at: string;
};

export type CaseRecord = Omit<CaseSummary, 'finding_count'> & {
  findings: Finding[];
  plans: PlanRow[];
  approvals: Approval[];
  certificate?: Certificate;
};

export async function caseList(status?: CaseSummary['status']): Promise<CaseSummary[]> {
  const value = await readTool('case_list', status ? { status } : {});
  return Array.isArray(value) ? value : [];
}

/** Returns null when the case does not exist, rather than throwing. */
export async function caseGet(caseId: string): Promise<CaseRecord | null> {
  try {
    return await readTool('case_get', { case_id: caseId });
  } catch (error) {
    if (error instanceof Error && /case not found/i.test(error.message)) return null;
    throw error;
  }
}
