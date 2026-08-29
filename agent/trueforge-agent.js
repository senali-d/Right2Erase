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
  'db_find_accounts',
  'db_get_account_emails',
  'db_list_orders',
  'db_list_order_items',
  'db_list_refunds',
  'db_list_retained_refunds',
  'db_list_support_tickets',
  'db_search_uploads',
  'db_search_event_log',
  'storage_list_objects',
  'storage_get_object_metadata',
  'storage_search_objects',
  'billing_find_customer',
  'billing_get_customer',
  'billing_list_charges',
  'billing_preview_erase',
  'db_export_subject_snapshot',
  'db_stage_deletion_actions',
  'db_rehearse_deletion_plan',
  'db_delete_snapshot',
]);

// Chunk size for db_stage_deletion_actions calls - comfortably under the
// server's default per-call cap (see MCP_DB_MAX_REHEARSAL_CHUNK in
// mcp/database-server.js) so a large discovered account's action set is
// always transmittable, no matter how many chunks that takes.
const STAGE_CHUNK_SIZE = 1000;

export const OUBLIETTE_TOOLS = new Set([
  'case_create',
  'case_get',
  'case_list',
  'finding_add',
  'case_complete_discovery',
  'plan_create',
  'plan_approve',
  'oubliette_execute_erasure',
]);

export const APPROVAL_REQUIRED_TOOLS = new Set(['oubliette_execute_erasure']);

function assertAllowed(tool) {
  if (!DISCOVERY_TOOLS.has(tool) && !OUBLIETTE_TOOLS.has(tool)) {
    throw new Error(`tool is not allowlisted: ${tool}`);
  }
}

export function createTrueForgeAgent({
  callTool,
  requestApproval = async () => false,
}) {
  if (typeof callTool !== 'function')
    throw new TypeError('callTool is required');

  const call = async (tool, args) => {
    assertAllowed(tool);
    return callTool(tool, args);
  };

  async function openAndInvestigate({ subject_email, subject_name }) {
    // Resolve identity before persisting anything: case_create has no way to
    // be undone (Oubliette keeps every case as a durable audit record), so an
    // identity collision must be caught while it is still just an in-memory
    // API response, not after it has already produced an orphaned case with
    // zero findings that nothing ever cleans up.
    const accounts = await call('db_find_accounts', { email: subject_email });
    const customers = await call('billing_find_customer', {
      email: subject_email,
    });
    const accountRows = Array.isArray(accounts)
      ? accounts
      : accounts.rows || [];
    // The billing adapter mirrors the API response as { results: [...] }.
    // Accept the other common MCP wrapper shapes as well, but never iterate
    // the wrapper object itself.
    const customerRows = Array.isArray(customers)
      ? customers
      : customers.results || customers.customers || customers.rows || [];

    // account_emails has no cross-account uniqueness constraint, so a
    // historical address can legitimately be recycled onto a different
    // person's account. Multiple distinct accounts matching subject_email is
    // therefore an identity collision, not a set of erasure targets - never
    // auto-resolve it, since silently picking one (or erasing all of them)
    // risks destroying an unrelated person's data.
    const distinctAccountIds = new Set(
      accountRows
        .map((row) => row.id ?? row.account_id)
        .filter((id) => id != null),
    );
    if (distinctAccountIds.size > 1) {
      const describe = accountRows
        .map(
          (row) =>
            `account ${row.id ?? row.account_id} (${row.matched_via || 'unknown match'})`,
        )
        .join(', ');
      throw new Error(
        `ambiguous identity for ${subject_email}: matches ${distinctAccountIds.size} distinct accounts [${describe}]; resolve the collision manually before opening a case`,
      );
    }

    // Nothing anywhere matches this subject. Opening a case here would leave a
    // permanent audit record with zero findings and a plan that deletes
    // nothing, which a reviewer would then be asked to approve - the same
    // orphan-case problem the collision check above exists to prevent, and a
    // typo is a far more common way to reach it than a collision.
    if (accountRows.length === 0 && customerRows.length === 0) {
      throw new Error(
        `no ShopKart data found for ${subject_email}: no account and no billing customer match; nothing to erase`,
      );
    }

    const caseRecord = await call('case_create', {
      subject_email,
      subject_name,
    });
    const caseId = caseRecord.case_id || caseRecord.id;
    if (!caseId) throw new Error('case_create did not return a case id');

    const rowsOf = (value) =>
      Array.isArray(value) ? value : value?.rows || [];
    const addRowFindings = (rows, record_type, disposition = 'erase') =>
      Promise.all(
        rows.map((row) =>
          call('finding_add', {
            case_id: caseId,
            system: 'postgres',
            record_type,
            record_id: row.id,
            metadata: { row },
            disposition,
          }),
        ),
      );
    const addIdFindings = (recordIds, record_type, disposition = 'erase') =>
      Promise.all(
        recordIds.map((record_id) =>
          call('finding_add', {
            case_id: caseId,
            system: 'postgres',
            record_type,
            record_id,
            metadata: {},
            disposition,
          }),
        ),
      );

    // MinIO objects are keyed by account-ID path (uploads/acct_<id>/), not by
    // email, so per-account prefix listings and the email search are separate
    // discovery paths that can surface the same object; dedupe by key.
    const minioObjects = new Map();
    const collectMinioObjects = (queryLabel, response) => {
      if (response.truncated) {
        throw new Error(
          `storage query (${queryLabel}) truncated at ${response.limit} results; refusing to plan an incomplete object erasure for ${subject_email}`,
        );
      }
      for (const object of response.objects || [])
        minioObjects.set(object.key, object);
    };

    // account_emails has no schema-level cap, so db_get_account_emails caps
    // each response and hands back a cursor; loop pages until the server
    // reports none remain instead of refusing accounts above the page size.
    async function fetchAllAccountEmails(accountId) {
      const rows = [];
      let cursor;
      for (;;) {
        const response = await call('db_get_account_emails', {
          account_id: accountId,
          cursor,
        });
        rows.push(...rowsOf(response));
        if (!response.truncated) return rows;
        if (response.next_cursor == null) {
          throw new Error(
            `db_get_account_emails (account ${accountId}) reported truncated with no next_cursor; cannot page further`,
          );
        }
        cursor = response.next_cursor;
      }
    }

    // Postgres erase actions for each account, in the same order they are
    // recorded as findings below - deliberately not leaf-to-root, so the
    // sandbox rehearsal in prepare() has a real ordering mistake to catch
    // (e.g. an order recorded before its order_items). Left unbounded here on
    // purpose: rehearsePlan() below stages this in chunks, so a large
    // discovered account is never truncated to fit one request.
    const postgresActionsByAccount = {};

    for (const account of accountRows) {
      const accountId = account.id || account.account_id;
      if (!accountId) continue;
      const [
        emailRows,
        orders,
        tickets,
        linkedUploads,
        orphanedUploads,
        accountObjects,
      ] = await Promise.all([
        fetchAllAccountEmails(accountId),
        call('db_list_orders', { account_id: accountId }),
        call('db_list_support_tickets', { account_id: accountId }),
        call('db_search_uploads', { account_id: accountId }),
        // uploads index rows can exist with account_id NULL and no FK back to
        // the account at all - the only surviving link is the account's key
        // prefix inside the object path, so an account_id lookup alone misses
        // them. Search by that prefix too and merge, deduped by row id.
        call('db_search_uploads', {
          object_prefix: `uploads/acct_${accountId}/`,
        }),
        call('storage_list_objects', { prefix: `uploads/acct_${accountId}/` }),
      ]);
      collectMinioObjects(`account ${accountId}`, accountObjects);
      const uploadRows = new Map();
      for (const row of rowsOf(linkedUploads)) uploadRows.set(row.id, row);
      // The prefix search recovers orphaned rows (account_id IS NULL); it must
      // never be trusted to add a row already linked to a different account,
      // so only its NULL-account_id results are merged in here.
      for (const row of rowsOf(orphanedUploads)) {
        if (row.account_id == null) uploadRows.set(row.id, row);
      }
      const uploads = [...uploadRows.values()];
      const orderRows = rowsOf(orders);
      const orderIds = orderRows.map((order) => order.id).filter(Boolean);
      const orderNumbers = orderRows
        .map((order) => order.order_number)
        .filter(Boolean);
      // db_search_event_log accepts at most 100 emails per call; partition
      // every known address (now fully paged in above) into batches so a
      // long historical-email chain doesn't lose event-log coverage past the
      // first 100.
      const knownEmails = [
        ...new Set([subject_email, ...emailRows.map((row) => row.email)]),
      ].filter(Boolean);
      const emailBatches = [];
      for (let i = 0; i < knownEmails.length; i += 100)
        emailBatches.push(knownEmails.slice(i, i + 100));
      if (emailBatches.length === 0) emailBatches.push([]);

      const [items, refunds, retainedRefunds] = await Promise.all([
        orderIds.length
          ? call('db_list_order_items', { order_ids: orderIds })
          : [],
        orderIds.length ? call('db_list_refunds', { order_ids: orderIds }) : [],
        orderNumbers.length
          ? call('db_list_retained_refunds', { order_numbers: orderNumbers })
          : [],
      ]);

      // Batches run one at a time rather than via Promise.all: the database
      // tool caps each call at 100 emails, but nothing caps how many batches
      // that produces, so firing them all concurrently would fan out an
      // unbounded number of simultaneous queries against a shared, small
      // connection pool. The IP condition is OR'd server-side, so passing it
      // on every batch would return the same IP-matched rows in each
      // response; scope it to the first batch and dedupe below regardless.
      const eventIds = new Set();
      for (const [index, batch] of emailBatches.entries()) {
        const response = await call('db_search_event_log', {
          emails: batch,
          ip_address:
            index === 0 ? account.last_seen_ip || undefined : undefined,
        });
        for (const id of response?.event_ids || []) eventIds.add(id);
      }
      // Ids only: db_search_event_log deliberately does not return hundreds of
      // full log rows, so event findings carry no metadata.row. The row itself
      // adds nothing an audit needs that the id and record_type do not already
      // give, and it is what made the response too large to stay in context.
      const logs = [...eventIds];

      // Every deletable row becomes its own finding so plan_create can turn it
      // into an executable leaf-to-root action; retained refunds are recorded
      // with a non-erase disposition so the executor withholds them instead.
      await Promise.all([
        addRowFindings(emailRows, 'account_email'),
        addRowFindings(orderRows, 'order'),
        addRowFindings(rowsOf(items), 'order_item'),
        addRowFindings(rowsOf(refunds), 'refund'),
        addRowFindings(rowsOf(retainedRefunds), 'retained_refund', 'retain'),
        addRowFindings(rowsOf(tickets), 'support_ticket'),
        addRowFindings(rowsOf(uploads), 'upload'),
        addIdFindings(logs, 'event'),
      ]);
      await call('finding_add', {
        case_id: caseId,
        system: 'postgres',
        record_type: 'account',
        record_id: accountId,
        metadata: { account },
        disposition: 'erase',
      });

      postgresActionsByAccount[accountId] = [
        ...emailRows.map((row) => ({
          record_type: 'account_email',
          record_id: row.id,
        })),
        ...orderRows.map((row) => ({
          record_type: 'order',
          record_id: row.id,
        })),
        ...rowsOf(items).map((row) => ({
          record_type: 'order_item',
          record_id: row.id,
        })),
        ...rowsOf(refunds).map((row) => ({
          record_type: 'refund',
          record_id: row.id,
        })),
        ...rowsOf(tickets).map((row) => ({
          record_type: 'support_ticket',
          record_id: row.id,
        })),
        ...rowsOf(uploads).map((row) => ({
          record_type: 'upload',
          record_id: row.id,
        })),
        ...logs.map((id) => ({ record_type: 'event', record_id: id })),
        { record_type: 'account', record_id: accountId },
      ];
    }

    for (const customer of customerRows) {
      const customerId = customer.id || customer.customer_id;
      if (!customerId) continue;
      const [details, charges, preview] = await Promise.all([
        call('billing_get_customer', { customer_id: customerId }),
        call('billing_list_charges', { customer_id: customerId }),
        call('billing_preview_erase', { customer_id: customerId }),
      ]);
      await call('finding_add', {
        case_id: caseId,
        system: 'billing',
        record_type: 'customer',
        record_id: customerId,
        metadata: { customer, details, charges, preview },
        disposition: 'erase',
      });
    }

    // Email search catches objects not scoped to a resolved account (e.g. keys
    // that embed the address itself); the account-ID prefix listings above are
    // the primary discovery path since objects are keyed by account, not email.
    const emailSearch = await call('storage_search_objects', {
      query: subject_email,
    });
    collectMinioObjects(`email ${subject_email}`, emailSearch);

    await Promise.all(
      [...minioObjects.values()].map((object) =>
        call('finding_add', {
          case_id: caseId,
          system: 'minio',
          record_type: 'object',
          record_id: object.key,
          locator: object.key,
          metadata: { object },
          disposition: 'erase',
        }),
      ),
    );

    // Only signal discovery as complete once every finding above - postgres,
    // billing, and MinIO - has actually been recorded. If any discovery call
    // throws (e.g. a truncated storage query), this is never reached and
    // plan_create permanently refuses to build a plan from the partial case.
    await call('case_complete_discovery', { case_id: caseId });
    return {
      case_id: caseId,
      accounts,
      customers,
      case: caseRecord,
      postgres_actions_by_account: postgresActionsByAccount,
    };
  }

  // Export a sandbox snapshot per account and rehearse that account's planned
  // Postgres deletes against it before any human ever sees the plan. A plan
  // that cannot be rehearsed cleanly (even after falling back to the known
  // leaf-to-root order) must never reach request_approval.
  async function rehearsePlan(postgresActionsByAccount) {
    const rehearsals = [];
    for (const [accountId, actions] of Object.entries(
      postgresActionsByAccount || {},
    )) {
      if (!actions.length) continue;
      // Each export gets its own uniquely named snapshot file, even for the
      // same account, addressed only by the opaque snapshot_id it returns -
      // never a path. A concurrent investigation of this account cannot
      // overwrite or delete the file this rehearsal is using, and neither
      // this agent nor anything it talks to can point db_rehearse_deletion_plan
      // or db_delete_snapshot at an arbitrary file, because those tools only
      // accept an id the server itself issued. If the export itself throws,
      // it never returns an id, so there is nothing here for this loop to
      // clean up: db_export_subject_snapshot only hands back an id once the
      // snapshot behind it is fully written.
      const snapshot = await call('db_export_subject_snapshot', {
        account_id: Number(accountId),
      });
      try {
        // Stage in bounded chunks, in order, rather than sending the whole
        // action list in one call: a large discovered account (thousands of
        // order_items, event_log rows, etc.) would otherwise exceed the
        // server's per-request size cap and become permanently unpreparable.
        // Chunks are staged sequentially, not concurrently, so their order on
        // the server matches this array's order exactly - the rehearsal that
        // follows still runs as one single transaction over the complete,
        // correctly ordered set; only how the actions get there is chunked.
        for (let i = 0; i < actions.length; i += STAGE_CHUNK_SIZE) {
          await call('db_stage_deletion_actions', {
            snapshot_id: snapshot.snapshot_id,
            actions: actions.slice(i, i + STAGE_CHUNK_SIZE),
          });
        }
        const outcome = await call('db_rehearse_deletion_plan', {
          snapshot_id: snapshot.snapshot_id,
          auto_order: true,
        });
        if (!outcome.ok) {
          throw new Error(
            `sandbox rehearsal failed for account ${accountId}: ${JSON.stringify(outcome.attempts)}`,
          );
        }
        rehearsals.push({
          account_id: Number(accountId),
          snapshot_id: snapshot.snapshot_id,
          snapshot_path: snapshot.snapshot_path,
          attempts: outcome.attempts,
        });
      } finally {
        // The exported snapshot is a full PII copy of the subject's reachable
        // data; it must not outlive the rehearsal it existed for, regardless
        // of whether that rehearsal passed or failed.
        await call('db_delete_snapshot', { snapshot_id: snapshot.snapshot_id });
      }
    }
    return rehearsals;
  }

  return {
    async prepare(request) {
      const {
        postgres_actions_by_account: postgresActionsByAccount,
        ...investigation
      } = await openAndInvestigate(request);
      const plan = await call('plan_create', {
        case_id: investigation.case_id,
      });
      const rehearsal = await rehearsePlan(postgresActionsByAccount);
      return { ...investigation, plan, rehearsal, awaiting_approval: true };
    },

    async executeApproved({ case_id, plan_hash, approved_by }) {
      if (!case_id || !plan_hash || !approved_by)
        throw new Error('case_id, plan_hash, and approved_by are required');
      const approved = await requestApproval({
        case_id,
        plan_hash,
        approved_by,
      });
      if (approved !== true)
        return { case_id, plan_hash, awaiting_approval: true, executed: false };
      const approval = await call('plan_approve', {
        case_id,
        plan_hash,
        approved_by,
      });
      const result = await call('oubliette_execute_erasure', {
        case_id,
        plan_hash,
        approved_by,
      });
      return {
        approval,
        execution: result,
        certificate: result.certificate,
        executed: true,
      };
    },
  };
}
