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
    const accountRows = Array.isArray(accounts) ? accounts : (accounts.rows || []);
    // The billing adapter mirrors the API response as { results: [...] }.
    // Accept the other common MCP wrapper shapes as well, but never iterate
    // the wrapper object itself.
    const customerRows = Array.isArray(customers)
      ? customers
      : (customers.results || customers.customers || customers.rows || []);

    // account_emails has no cross-account uniqueness constraint, so a
    // historical address can legitimately be recycled onto a different
    // person's account. Multiple distinct accounts matching subject_email is
    // therefore an identity collision, not a set of erasure targets - never
    // auto-resolve it, since silently picking one (or erasing all of them)
    // risks destroying an unrelated person's data.
    const distinctAccountIds = new Set(
      accountRows.map((row) => row.id ?? row.account_id).filter((id) => id != null),
    );
    if (distinctAccountIds.size > 1) {
      const describe = accountRows
        .map((row) => `account ${row.id ?? row.account_id} (${row.matched_via || 'unknown match'})`)
        .join(', ');
      throw new Error(
        `ambiguous identity for ${subject_email}: matches ${distinctAccountIds.size} distinct accounts [${describe}]; resolve the collision manually before opening a case`,
      );
    }

    const rowsOf = (value) => (Array.isArray(value) ? value : (value?.rows || []));
    const addRowFindings = (rows, record_type, disposition = 'erase') => Promise.all(
      rows.map((row) => call('finding_add', {
        case_id: caseId, system: 'postgres', record_type, record_id: row.id, metadata: { row }, disposition,
      })),
    );

    // MinIO objects are keyed by account-ID path (uploads/acct_<id>/), not by
    // email, so per-account prefix listings and the email search are separate
    // discovery paths that can surface the same object; dedupe by key.
    const minioObjects = new Map();
    const collectMinioObjects = (queryLabel, response) => {
      if (response.truncated) {
        throw new Error(`storage query (${queryLabel}) truncated at ${response.limit} results; refusing to plan an incomplete object erasure for ${subject_email}`);
      }
      for (const object of response.objects || []) minioObjects.set(object.key, object);
    };

    for (const account of accountRows) {
      const accountId = account.id || account.account_id;
      if (!accountId) continue;
      const [emails, orders, tickets, uploads, accountObjects] = await Promise.all([
        call('db_get_account_emails', { account_id: accountId }),
        call('db_list_orders', { account_id: accountId }),
        call('db_list_support_tickets', { account_id: accountId }),
        call('db_search_uploads', { account_id: accountId }),
        call('storage_list_objects', { prefix: `uploads/acct_${accountId}/` }),
      ]);
      collectMinioObjects(`account ${accountId}`, accountObjects);
      const orderRows = rowsOf(orders);
      const orderIds = orderRows.map((order) => order.id).filter(Boolean);
      const orderNumbers = orderRows.map((order) => order.order_number).filter(Boolean);
      // db_search_event_log accepts at most 100 emails per call, but
      // db_get_account_emails has no such cap; partition every known address
      // into batches so an account with a long historical-email chain doesn't
      // silently lose event-log coverage past the first 100.
      const knownEmails = [...new Set([subject_email, ...rowsOf(emails).map((row) => row.email)])]
        .filter(Boolean);
      const emailBatches = [];
      for (let i = 0; i < knownEmails.length; i += 100) emailBatches.push(knownEmails.slice(i, i + 100));
      if (emailBatches.length === 0) emailBatches.push([]);

      const [items, refunds, retainedRefunds, ...logBatches] = await Promise.all([
        orderIds.length ? call('db_list_order_items', { order_ids: orderIds }) : [],
        orderIds.length ? call('db_list_refunds', { order_ids: orderIds }) : [],
        orderNumbers.length ? call('db_list_retained_refunds', { order_numbers: orderNumbers }) : [],
        // The IP condition is OR'd server-side, so passing it on every batch
        // would return the same IP-matched rows in each response; scope it to
        // the first batch and dedupe the merged rows defensively below.
        ...emailBatches.map((batch, index) => call('db_search_event_log', {
          emails: batch,
          ip_address: index === 0 ? (account.last_seen_ip || undefined) : undefined,
        })),
      ]);
      const eventRows = new Map();
      for (const batch of logBatches) {
        for (const row of rowsOf(batch)) eventRows.set(row.id, row);
      }
      const logs = [...eventRows.values()];

      // Every deletable row becomes its own finding so plan_create can turn it
      // into an executable leaf-to-root action; retained refunds are recorded
      // with a non-erase disposition so the executor withholds them instead.
      await Promise.all([
        addRowFindings(rowsOf(emails), 'account_email'),
        addRowFindings(orderRows, 'order'),
        addRowFindings(rowsOf(items), 'order_item'),
        addRowFindings(rowsOf(refunds), 'refund'),
        addRowFindings(rowsOf(retainedRefunds), 'retained_refund', 'retain'),
        addRowFindings(rowsOf(tickets), 'support_ticket'),
        addRowFindings(rowsOf(uploads), 'upload'),
        addRowFindings(rowsOf(logs), 'event'),
      ]);
      await call('finding_add', { case_id: caseId, system: 'postgres', record_type: 'account', record_id: accountId, metadata: { account }, disposition: 'erase' });
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

    // Email search catches objects not scoped to a resolved account (e.g. keys
    // that embed the address itself); the account-ID prefix listings above are
    // the primary discovery path since objects are keyed by account, not email.
    const emailSearch = await call('storage_search_objects', { query: subject_email });
    collectMinioObjects(`email ${subject_email}`, emailSearch);

    await Promise.all([...minioObjects.values()].map((object) => call('finding_add', {
      case_id: caseId, system: 'minio', record_type: 'object', record_id: object.key, locator: object.key, metadata: { object }, disposition: 'erase',
    })));
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
