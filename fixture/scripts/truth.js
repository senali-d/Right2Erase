#!/usr/bin/env node
/**
 * Ground truth for the fixture.
 *
 * Computes, independently of the agent, exactly what a correct erasure for a
 * given subject should touch. Use it two ways:
 *
 *   npm run truth                    # print the expected manifest
 *   npm run truth -- --diff plan.json  # compare the agent's plan against it
 *
 * This file is NOT reachable by the agent. It exists so you can prove your
 * discovery actually discovered things rather than being told the answers.
 * Keep it out of the agent's MCP surface.
 */

import pg from 'pg';
import { readFile } from 'node:fs/promises';

const DB = process.env.DATABASE_URL || 'postgres://shopkart:shopkart@localhost:5432/shopkart';
const subjectEmail = process.env.SUBJECT_EMAIL || 'ravi.sharma@example.com';

const diffIndex = process.argv.indexOf('--diff');
const planPath = diffIndex > -1 ? process.argv[diffIndex + 1] : null;

async function truth(client, email) {
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

  // Withheld: pending refunds are a live financial obligation.
  const { rows: held } = await client.query(
    `SELECT r.id, o.order_number, r.amount_cents, r.reason FROM refunds r
      JOIN orders o ON o.id = r.order_id
     WHERE o.account_id=$1 AND r.status='pending'`, [a.id]);

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
      table: 'refunds', id: h.id, order: h.order_number,
      amount_cents: h.amount_cents, reason: `retention: ${h.reason}`,
    })),
    must_not_touch: collisions,
    // Leaf-to-root. Any other order and Postgres raises a FK violation.
    safe_delete_order: [
      'order_items', 'refunds(settled only)', 'orders',
      'support_tickets', 'uploads', 'account_emails', 'event_log', 'accounts',
    ],
  };
}

function walk(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, walk(v, `${prefix}${k}.`));
    else out[`${prefix}${k}`] = v;
  }
  return out;
}

const client = new pg.Client({ connectionString: DB });
await client.connect();
const expected = await truth(client, subjectEmail);
await client.end();

if (!planPath) {
  console.log(JSON.stringify(expected, null, 2));
  process.exit(0);
}

const plan = JSON.parse(await readFile(planPath, 'utf8'));
const e = walk(expected.delete);
const g = walk(plan.delete || {});
let bad = 0;

console.log('\n  key                        expected   agent');
console.log('  ' + '-'.repeat(46));
for (const k of Object.keys(e)) {
  const ok = e[k] === g[k];
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${k.padEnd(24)} ${String(e[k]).padStart(6)}  ${String(g[k] ?? '—').padStart(6)}`);
}

const withheldOk = (plan.withhold || []).length === expected.withhold.length;
if (!withheldOk) bad++;
console.log(`  ${withheldOk ? '✓' : '✗'} withheld records         ${String(expected.withhold.length).padStart(6)}  ${String((plan.withhold || []).length).padStart(6)}`);

const swept = (plan.delete?.account_ids || []).filter((id) =>
  expected.must_not_touch.some((c) => c.id === id));
if (swept.length) {
  bad++;
  console.log(`  ✗ SWEEPS COLLIDING ACCOUNT: ${swept.join(', ')}`);
}

console.log(bad === 0 ? '\n  plan matches ground truth\n' : `\n  ${bad} mismatch(es)\n`);
process.exit(bad === 0 ? 0 : 1);
