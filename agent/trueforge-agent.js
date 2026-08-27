/**
 * TrueForge agent workflow.
 *
 * The agent is deliberately a thin orchestration layer. MCP servers own data
 * access and Oubliette owns all destructive execution and audit guarantees.
 */

export const MCP_SERVERS = {
  oubliette: process.env.OUBLIETTE_MCP_URL || 'http://127.0.0.1:4014/mcp',
  database: process.env.SHOPKART_DB_MCP_URL || 'http://127.0.0.1:4012/mcp',
  storage: process.env.SHOPKART_STORAGE_MCP_URL || 'http://127.0.0.1:4013/mcp',
  billing: process.env.SHOPKART_BILLING_MCP_URL || 'http://127.0.0.1:4011/mcp',
};

export const DISCOVERY_TOOLS = new Set([
  'db_find_accounts', 'db_get_account_emails', 'db_list_orders',
  'db_list_order_items', 'db_list_refunds', 'db_list_retained_refunds',
  'db_list_support_tickets', 'db_search_uploads', 'db_search_event_log',
  'storage_list_objects', 'storage_get_object_metadata', 'storage_search_objects',
  'billing_find_customer', 'billing_get_customer', 'billing_list_charges',
  'billing_preview_erase',
]);

export const OUBLIETTE_TOOLS = new Set([
  'case_create', 'case_get', 'case_list', 'finding_add', 'plan_create',
  'plan_approve', 'oubliette_execute_erasure',
]);

export const APPROVAL_REQUIRED_TOOLS = new Set(['oubliette_execute_erasure']);

function assertAllowed(tool) {
  if (!DISCOVERY_TOOLS.has(tool) && !OUBLIETTE_TOOLS.has(tool)) {
    throw new Error(`tool is not allowlisted: ${tool}`);
  }
}

export function createTrueForgeAgent({ callTool, requestApproval = async () => false }) {
  if (typeof callTool !== 'function') throw new TypeError('callTool is required');

  const call = async (tool, args) => {
    assertAllowed(tool);
    return callTool(tool, args);
  };

  async function openAndInvestigate({ subject_email, subject_name }) {
    const caseRecord = await call('case_create', { subject_email, subject_name });
    const caseId = caseRecord.case_id || caseRecord.id;
    if (!caseId) throw new Error('case_create did not return a case id');

    const accounts = await call('db_find_accounts', { email: subject_email });
    const customers = await call('billing_find_customer', { email: subject_email });
    const accountRows = accounts.rows || accounts;
    const customerRows = customers.customers || customers.rows || customers;

    for (const account of accountRows) {
      const accountId = account.id || account.account_id;
      if (!accountId) continue;
      const [emails, orders, tickets, uploads] = await Promise.all([
        call('db_get_account_emails', { account_id: accountId }),
        call('db_list_orders', { account_id: accountId }),
        call('db_list_support_tickets', { account_id: accountId }),
        call('db_search_uploads', { account_id: accountId }),
      ]);
      const orderRows = orders.rows || orders;
      const orderIds = orderRows.map((order) => order.id).filter(Boolean);
      const [refunds, logs] = await Promise.all([
        orderIds.length ? call('db_list_refunds', { order_ids: orderIds }) : [],
        call('db_search_event_log', { emails: [subject_email], ip_address: account.last_seen_ip || undefined }),
      ]);
      await call('finding_add', { case_id: caseId, system: 'postgres', record_type: 'account', record_id: accountId, metadata: { account, emails, orders, refunds, tickets, uploads, logs }, disposition: 'erase' });
    }

    for (const customer of customerRows) {
      const customerId = customer.id || customer.customer_id;
      if (!customerId) continue;
      const [details, charges, preview] = await Promise.all([
        call('billing_get_customer', { customer_id: customerId }),
        call('billing_list_charges', { customer_id: customerId }),
        call('billing_preview_erase', { customer_id: customerId }),
      ]);
      await call('finding_add', { case_id: caseId, system: 'billing', record_type: 'customer', record_id: customerId, metadata: { customer, details, charges, preview }, disposition: 'erase' });
    }

    const objects = await call('storage_search_objects', { query: subject_email });
    await call('finding_add', { case_id: caseId, system: 'minio', record_type: 'object-search', record_id: subject_email, metadata: { objects }, disposition: 'erase' });
    return { case_id: caseId, accounts, customers, case: caseRecord };
  }

  return {
    async prepare(request) {
      const investigation = await openAndInvestigate(request);
      const plan = await call('plan_create', { case_id: investigation.case_id });
      return { ...investigation, plan, awaiting_approval: true };
    },

    async executeApproved({ case_id, plan_hash, approved_by }) {
      if (!case_id || !plan_hash || !approved_by) throw new Error('case_id, plan_hash, and approved_by are required');
      const approved = await requestApproval({ case_id, plan_hash, approved_by });
      if (approved !== true) return { case_id, plan_hash, awaiting_approval: true, executed: false };
      const approval = await call('plan_approve', { case_id, plan_hash, approved_by });
      const result = await call('oubliette_execute_erasure', { case_id, plan_hash, approved_by });
      return { approval, execution: result, certificate: result.certificate, executed: true };
    },
  };
}
