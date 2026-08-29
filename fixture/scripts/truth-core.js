/**
 * Ground truth computation for the fixture.
 *
 * Extracted from truth.js so the operator-facing web UI can render the same
 * expected manifest the CLI prints. This is deliberately NOT reachable by the
 * agent: it is never exposed as an MCP tool, and nothing under agent/ or mcp/
 * may import it. Its whole value is that it derives the answer independently,
 * straight from Postgres, rather than reading back what the agent decided.
 */

import pg from 'pg';

export const DEFAULT_DATABASE_URL = 'postgres://shopkart:shopkart@localhost:5432/shopkart';
export const DEFAULT_SUBJECT_EMAIL = 'ravi.sharma@example.com';

export async function truth(client, email) {
  const { rows: acct } = await client.query(
    `SELECT id, email, full_name, last_seen_ip FROM accounts WHERE email = $1`, [email],
  );
  if (!acct.length) throw new Error(`no account for ${email}`);
  const a = acct[0];

  const { rows: emails } = await client.query(
    `SELECT email FROM account_emails WHERE account_id = $1`, [a.id],
  );
  const allEmails = [...new Set(emails.map((e) => e.email).concat(a.email))];

  const one = async (sql, params) => (await client.query(sql, params)).rows[0].count | 0;

  const orders = await one(`SELECT count(*)::int AS count FROM orders WHERE account_id=$1`, [a.id]);
  const items = await one(
    `SELECT count(*)::int AS count FROM order_items i
      JOIN orders o ON o.id = i.order_id WHERE o.account_id=$1`, [a.id]);
  const refundsSettled = await one(
    `SELECT count(*)::int AS count FROM refunds r
      JOIN orders o ON o.id = r.order_id
     WHERE o.account_id=$1 AND r.status='settled'`, [a.id]);
  const tickets = await one(`SELECT count(*)::int AS count FROM support_tickets WHERE account_id=$1`, [a.id]);
  const linkedUploads = await one(`SELECT count(*)::int AS count FROM uploads WHERE account_id=$1`, [a.id]);
  const orphanUploads = await one(
    `SELECT count(*)::int AS count FROM uploads
      WHERE account_id IS NULL AND object_key LIKE $1`, [`uploads/acct_${a.id}/%`]);
  const events = await one(
    `SELECT count(*)::int AS count FROM event_log
      WHERE email = ANY($1) OR ip_address = $2`, [allEmails, a.last_seen_ip]);

  // Withheld: retained refunds are live financial obligations detached from
  // the customer hierarchy, so they survive deletion of the account and order.
  const { rows: held } = await client.query(
    `SELECT rr.id, rr.source_order_number AS order_number,
            rr.amount_cents, rr.reason
       FROM retained_refunds rr
       JOIN orders o ON o.order_number = rr.source_order_number
      WHERE o.account_id=$1`, [a.id]);

  // Anyone sharing the display name who must NOT be touched.
  const { rows: collisions } = await client.query(
    `SELECT id, email FROM accounts WHERE full_name=$1 AND id<>$2`, [a.full_name, a.id],
  );

  return {
    subject: { account_id: a.id, email: a.email, known_emails: allEmails },
    delete: {
      accounts: 1,
      orders,
      order_items: items,
      refunds_settled: refundsSettled,
      support_tickets: tickets,
      uploads_linked: linkedUploads,
      uploads_orphaned: orphanUploads,
      event_log: events,
      billing_customers: 1,
    },
    total_rows: 1 + orders + items + refundsSettled + tickets + linkedUploads + orphanUploads + events,
    withhold: held.map((h) => ({
      table: 'retained_refunds', id: h.id, order: h.order_number,
      amount_cents: h.amount_cents, reason: `retention: ${h.reason}`,
    })),
    must_not_touch: collisions,
    // Leaf-to-root. Retained refunds are detached and are not part of this
    // deletion path; any other order raises a FK violation.
    safe_delete_order: [
      'order_items', 'refunds(settled only)', 'orders',
      'support_tickets', 'uploads', 'account_emails', 'event_log', 'accounts',
    ],
  };
}

/** Open a connection, compute the expected manifest, and always close it. */
export async function computeTruth({ connectionString = DEFAULT_DATABASE_URL, email = DEFAULT_SUBJECT_EMAIL } = {}) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await truth(client, email);
  } finally {
    await client.end();
  }
}
