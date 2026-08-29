#!/usr/bin/env node
/**
 * Seeds the ShopKart fixture.
 *
 * Deterministic: same seed value in, same database out, so the numbers in your
 * demo video match the numbers a judge gets when they clone the repo.
 *
 *   npm run seed            # normal run
 *   npm run seed -- --quiet # no per-case output
 *
 * Everything here is generated. No real person's data goes near this repo.
 */

import { faker } from '@faker-js/faker';
import pg from 'pg';
import * as Minio from 'minio';

const SEED = 4217;
faker.seed(SEED);

/**
 * How much fixture to build.
 *
 * The five hard cases are structural, not statistical - they are the same five
 * traps at either size - so the profile only changes how much data surrounds
 * them. What it really controls is the subject's own footprint, because every
 * record he owns becomes a finding the agent has to read, stage, rehearse and
 * delete. That, not the size of the crowd, is what an investigation costs:
 * dropping the background from 200 accounts to 20 leaves the plan at an
 * identical 444 deletions, because none of his data comes from the background
 * loop.
 *
 * 'full' is the demo - five needles found among 200 accounts, which is the
 * whole point. 'small' is for iterating on the agent without paying for 444
 * findings a run, and for a deployment where boot time and model tokens cost
 * something.
 *
 * 'full' must stay exactly as it was: faker is seeded once for the entire run,
 * so any change to these numbers shifts every random draw after it. That is
 * also why 'small' is not a subset of 'full' - the two are separately
 * deterministic, not nested.
 */
const PROFILES = {
  full: {
    accountCount: 200,
    backgroundOrders: { min: 0, max: 14 },
    backgroundTickets: { min: 0, max: 3 },
    backgroundEvents: { min: 5, max: 40 },
    subjectOrders: 12,
    subjectTickets: 3,
    subjectOldEmailEvents: 180,
    subjectNewEmailEvents: 220,
    decoyOrders: 5,
    decoyTickets: 1,
    decoyEvents: 60,
  },
  small: {
    accountCount: 1, // 1 background + subject + decoy = 3 accounts
    backgroundOrders: { min: 0, max: 2 },
    backgroundTickets: { min: 0, max: 1 },
    backgroundEvents: { min: 2, max: 5 },
    subjectOrders: 4,
    subjectTickets: 1,
    subjectOldEmailEvents: 4,
    subjectNewEmailEvents: 6,
    decoyOrders: 2,
    decoyTickets: 1,
    decoyEvents: 3,
  },
};

const PROFILE_NAME = process.env.SEED_PROFILE || 'full';
const PROFILE = PROFILES[PROFILE_NAME];
if (!PROFILE) {
  console.error(`unknown SEED_PROFILE "${PROFILE_NAME}" - expected one of: ${Object.keys(PROFILES).join(', ')}`);
  process.exit(1);
}

// Case 2 needs two *different* subject orders: one carrying the live retention
// hold and one carrying the settled refund that is safe to delete. Telling them
// apart is the case. Below three orders the two indices collide and the trap
// disarms itself silently, so refuse rather than seed a fixture that looks
// right and proves nothing.
if (PROFILE.subjectOrders < 3) {
  console.error(`SEED_PROFILE "${PROFILE_NAME}" gives the subject ${PROFILE.subjectOrders} orders; case 2 needs at least 3`);
  process.exit(1);
}

const CONFIG = {
  pg: process.env.DATABASE_URL || 'postgres://shopkart:shopkart@localhost:5432/shopkart',
  minio: {
    endPoint: process.env.MINIO_HOST || 'localhost',
    port: Number(process.env.MINIO_PORT || 9000),
    useSSL: false,
    accessKey: process.env.MINIO_ACCESS_KEY || 'shopkart',
    secretKey: process.env.MINIO_SECRET_KEY || 'shopkart123',
  },
  bucket: process.env.MINIO_BUCKET || 'shopkart-uploads',
  billingUrl: process.env.BILLING_URL || 'http://localhost:4010',
  // SEED_ACCOUNTS still overrides the profile, so every existing invocation
  // keeps working unchanged.
  accountCount: Number(process.env.SEED_ACCOUNTS || PROFILE.accountCount),
};

// The erasure subject. Everything about him is invented.
const SUBJECT = {
  email: 'ravi.sharma@example.com',
  oldEmail: 'ravi.s@oldmail.example',
  fullName: 'Ravi Sharma',
  ip: '203.0.113.47', // TEST-NET-3, reserved for documentation
};

// Same display name, different human. If discovery matches on name, it will
// sweep this person up and the agent has quietly destroyed a stranger's data.
const DECOY = {
  email: 'r.sharma@example.net',
  fullName: 'Ravi Sharma',
  ip: '198.51.100.12',
};

const quiet = process.argv.includes('--quiet');
const log = (...a) => { if (!quiet) console.log(...a); };

const SKUS = [
  ['SK-1001', 'Cotton Oxford Shirt'],
  ['SK-1002', 'Leather Card Holder'],
  ['SK-1003', 'Stainless Water Bottle'],
  ['SK-1004', 'Merino Crew Socks'],
  ['SK-1005', 'Canvas Weekender Bag'],
  ['SK-1006', 'Ceramic Pour-Over Set'],
  ['SK-1007', 'Linen Pillowcase Pair'],
  ['SK-1008', 'Walnut Desk Tray'],
];

const PATHS = ['/', '/cart', '/checkout', '/account', '/orders', '/support', '/search'];
const TICKET_SUBJECTS = [
  'Where is my order?',
  'Wrong size delivered',
  'Refund not received',
  'Change delivery address',
  'Item arrived damaged',
];

function orderNumber(n) {
  return `SK-${String(n).padStart(5, '0')}`;
}

async function main() {
  const client = new pg.Client({ connectionString: CONFIG.pg });
  await client.connect();
  log(`\nShopKart fixture · seed=${SEED} · profile=${PROFILE_NAME}\n`);

  // ---------------------------------------------------------------- schema
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const schemaPath = fileURLToPath(new URL('../db/schema.sql', import.meta.url));
  await client.query(await readFile(schemaPath, 'utf8'));
  log('  schema applied');

  // ---------------------------------------------------------------- minio
  const minio = new Minio.Client(CONFIG.minio);
  if (await minio.bucketExists(CONFIG.bucket)) {
    const keys = [];
    const stream = minio.listObjectsV2(CONFIG.bucket, '', true);
    await new Promise((res, rej) => {
      stream.on('data', (o) => keys.push(o.name));
      stream.on('end', res);
      stream.on('error', rej);
    });
    if (keys.length) await minio.removeObjects(CONFIG.bucket, keys);
  } else {
    await minio.makeBucket(CONFIG.bucket);
  }
  log(`  bucket ${CONFIG.bucket} ready`);

  const uploads = [];   // { accountId|null, key, kind, bytes, body }
  const billing = [];   // { email, name, card, charges[] }
  let orderSeq = 8000;

  // ------------------------------------------------------- account factory
  async function createAccount({ email, fullName, ip, orders, tickets }) {
    const created = faker.date.between({ from: '2023-01-10', to: '2024-06-01' });
    const { rows } = await client.query(
      `INSERT INTO accounts (email, full_name, country, last_seen_ip, created_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [email, fullName, faker.location.countryCode(), ip, created],
    );
    const id = rows[0].id;

    await client.query(
      `INSERT INTO account_emails (account_id, email, is_primary, valid_from)
       VALUES ($1,$2,true,$3)`,
      [id, email, created],
    );

    const orderIds = [];
    for (let i = 0; i < orders; i++) {
      const placed = faker.date.between({ from: created, to: '2025-08-01' });
      const items = faker.number.int({ min: 1, max: 3 });
      let total = 0;
      const chosen = faker.helpers.arrayElements(SKUS, items);
      const lines = chosen.map(([sku, name]) => {
        const qty = faker.number.int({ min: 1, max: 2 });
        const price = faker.number.int({ min: 899, max: 9900 });
        total += qty * price;
        return { sku, name, qty, price };
      });

      const { rows: o } = await client.query(
        `INSERT INTO orders (account_id, order_number, total_cents, status, ship_address, created_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          id,
          orderNumber(++orderSeq),
          total,
          faker.helpers.arrayElement(['placed', 'shipped', 'delivered', 'delivered', 'returned']),
          `${faker.location.streetAddress()}, ${faker.location.city()}`,
          placed,
        ],
      );
      orderIds.push({ id: o[0].id, number: orderNumber(orderSeq), placed, total });

      for (const l of lines) {
        await client.query(
          `INSERT INTO order_items (order_id, sku, product_name, qty, price_cents)
           VALUES ($1,$2,$3,$4,$5)`,
          [o[0].id, l.sku, l.name, l.qty, l.price],
        );
      }
    }

    for (let i = 0; i < tickets; i++) {
      await client.query(
        `INSERT INTO support_tickets (account_id, subject, body, status, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          id,
          faker.helpers.arrayElement(TICKET_SUBJECTS),
          faker.lorem.paragraph(),
          faker.helpers.arrayElement(['open', 'closed', 'closed']),
          faker.date.between({ from: created, to: '2025-08-01' }),
        ],
      );
    }

    return { id, created, orderIds };
  }

  async function logEvents(email, ip, count, from, to) {
    for (let i = 0; i < count; i++) {
      await client.query(
        `INSERT INTO event_log (ts, email, ip_address, method, path, status_code, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          faker.date.between({ from, to }),
          email,
          ip,
          faker.helpers.arrayElement(['GET', 'GET', 'GET', 'POST']),
          faker.helpers.arrayElement(PATHS),
          faker.helpers.arrayElement([200, 200, 200, 302, 404]),
          faker.internet.userAgent(),
        ],
      );
    }
  }

  // ------------------------------------------------------------ background
  log(`  seeding ${CONFIG.accountCount} background accounts...`);
  for (let i = 0; i < CONFIG.accountCount; i++) {
    const first = faker.person.firstName();
    const last = faker.person.lastName();
    const email = faker.internet.email({ firstName: first, lastName: last }).toLowerCase();
    const ip = faker.internet.ipv4();
    const acct = await createAccount({
      email,
      fullName: `${first} ${last}`,
      ip,
      orders: faker.number.int(PROFILE.backgroundOrders),
      tickets: faker.number.int(PROFILE.backgroundTickets),
    });

    await logEvents(email, ip, faker.number.int(PROFILE.backgroundEvents), acct.created, '2025-08-20');

    if (faker.datatype.boolean(0.6)) {
      uploads.push({
        accountId: acct.id,
        key: `uploads/acct_${acct.id}/avatar.png`,
        kind: 'avatar',
        body: `png-fixture:${acct.id}`,
      });
    }
    if (faker.datatype.boolean(0.35)) {
      billing.push({
        email,
        name: `${first} ${last}`,
        card: { brand: faker.helpers.arrayElement(['visa', 'mastercard']), last4: faker.finance.creditCardNumber('####').slice(-4) },
        charges: acct.orderIds.slice(0, 4).map((o) => ({ order_number: o.number, amount_cents: o.total, at: o.placed })),
      });
    }
  }
  log('  background accounts done');

  // ------------------------------------------------------ CASE 1 + subject
  const subject = await createAccount({
    email: SUBJECT.email,
    fullName: SUBJECT.fullName,
    ip: SUBJECT.ip,
    orders: PROFILE.subjectOrders,
    tickets: PROFILE.subjectTickets,
  });
  log(`\n  subject: ${SUBJECT.email} (account ${subject.id})`);
  log(`  CASE 1  foreign-key ordering trap: ${PROFILE.subjectOrders} orders + items + settled refunds hang off the account`);

  // ------------------------------------------------- CASE 2 retention hold
  // Relative, not a fixed 4: a small profile gives the subject fewer orders
  // than that index assumes, and an undefined `held` takes case 4's orphan key
  // down with it. At 12 orders this still resolves to 4, so the full fixture
  // keeps the same held order and the same plan hash.
  const held = subject.orderIds[Math.min(4, PROFILE.subjectOrders - 1)];
  // Live obligations are placed in the detached retention model. They retain
  // only a non-PII order reference, so the customer hierarchy can be erased.
  await client.query(
    `INSERT INTO retained_refunds (source_order_number, amount_cents, reason, opened_at)
     VALUES ($1,$2,$3,$4)`,
    [held.number, Math.round(held.total * 0.4), 'Item returned, inspection pending', new Date('2025-08-11T09:14:00Z')],
  );
  // ...and a settled one, which IS safe to delete. The agent has to tell them apart.
  const settled = subject.orderIds[1];
  await client.query(
    `INSERT INTO refunds (order_id, amount_cents, status, reason, opened_at, settled_at)
     VALUES ($1,$2,'settled',$3,$4,$5)`,
    [settled.id, settled.total, 'Wrong size', new Date('2024-11-02T10:00:00Z'), new Date('2024-11-09T10:00:00Z')],
  );
  log(`  CASE 2  retention hold: order ${held.number} has an unsettled refund (a settled one also exists)`);

  // ------------------------------------------------- CASE 3 name collision
  const decoy = await createAccount({
    email: DECOY.email,
    fullName: DECOY.fullName,
    ip: DECOY.ip,
    orders: PROFILE.decoyOrders,
    tickets: PROFILE.decoyTickets,
  });
  await logEvents(DECOY.email, DECOY.ip, PROFILE.decoyEvents, decoy.created, '2025-08-20');
  uploads.push({
    accountId: decoy.id,
    key: `uploads/acct_${decoy.id}/avatar.png`,
    kind: 'avatar',
    body: `png-fixture:${decoy.id}`,
  });
  log(`  CASE 3  name collision: ${DECOY.email} (account ${decoy.id}) shares the display name and must survive`);

  // ------------------------------------------------- CASE 4 orphaned file
  uploads.push({
    accountId: subject.id,
    key: `uploads/acct_${subject.id}/avatar.png`,
    kind: 'avatar',
    body: `png-fixture:${subject.id}`,
  });
  uploads.push({
    accountId: null, // no DB link at all
    key: `uploads/acct_${subject.id}/return-receipt-${held.number}.pdf`,
    kind: 'return_receipt',
    body: `pdf-fixture:${SUBJECT.email}:${held.number}`,
  });
  log('  CASE 4  orphaned object: return receipt has NULL account_id, linkable only by key path');

  // -------------------------------------------------- CASE 5 old address
  const switchedAt = new Date('2024-09-15T00:00:00Z');
  await client.query(
    `INSERT INTO account_emails (account_id, email, is_primary, valid_from, valid_until)
     VALUES ($1,$2,false,$3,$4)`,
    [subject.id, SUBJECT.oldEmail, subject.created, switchedAt],
  );
  await logEvents(SUBJECT.oldEmail, SUBJECT.ip, PROFILE.subjectOldEmailEvents, subject.created, switchedAt);
  await logEvents(SUBJECT.email, SUBJECT.ip, PROFILE.subjectNewEmailEvents, switchedAt, '2025-08-20');
  log(`  CASE 5  identity chain: ${PROFILE.subjectOldEmailEvents} log rows filed under ${SUBJECT.oldEmail}`);

  // ---------------------------------------------------------- write objects
  for (const u of uploads) {
    const buf = Buffer.from(u.body, 'utf8');
    await minio.putObject(CONFIG.bucket, u.key, buf);
    await client.query(
      `INSERT INTO uploads (account_id, object_key, kind, bytes, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [u.accountId, u.key, u.kind, buf.length, faker.date.between({ from: '2023-06-01', to: '2025-08-01' })],
    );
  }
  log(`\n  ${uploads.length} objects written to ${CONFIG.bucket}`);

  // ------------------------------------------------------------- billing
  billing.push({
    email: SUBJECT.email,
    name: SUBJECT.fullName,
    card: { brand: 'visa', last4: '4242' },
    charges: subject.orderIds.map((o) => ({ order_number: o.number, amount_cents: o.total, at: o.placed })),
  });
  billing.push({
    email: DECOY.email,
    name: DECOY.fullName,
    card: { brand: 'mastercard', last4: '8210' },
    charges: decoy.orderIds.map((o) => ({ order_number: o.number, amount_cents: o.total, at: o.placed })),
  });

  const res = await fetch(`${CONFIG.billingUrl}/admin/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customers: billing }),
  });
  if (!res.ok) throw new Error(`billing-api reset failed: ${res.status} ${await res.text()}`);
  log(`  ${billing.length} customers loaded into billing-api`);

  // -------------------------------------------------------------- summary
  const counts = await client.query(`
    SELECT
      (SELECT count(*) FROM accounts)         AS accounts,
      (SELECT count(*) FROM orders)           AS orders,
      (SELECT count(*) FROM order_items)      AS order_items,
      (SELECT count(*) FROM refunds)          AS refunds,
      (SELECT count(*) FROM support_tickets)  AS tickets,
      (SELECT count(*) FROM uploads)          AS uploads,
      (SELECT count(*) FROM event_log)        AS events`);

  log('\n  totals:', counts.rows[0]);
  log(`\n  Subject for the demo: ${SUBJECT.email}`);
  log('  Ground truth for what SHOULD be found:  npm run truth\n');

  await client.end();
}

main().catch((err) => {
  console.error('\nseed failed:', err.message);
  process.exit(1);
});
