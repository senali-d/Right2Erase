#!/usr/bin/env node
/**
 * Stand-in for a third-party payment processor.
 *
 * Deliberately NOT a database: it is an external HTTP service the agent can
 * only reach through an API, which is what makes it a separate discovery
 * problem from Postgres. State is in memory and resets with the process.
 *
 * Endpoints the agent sees (via the MCP server next door):
 *   GET  /customers?email=          find a customer
 *   GET  /customers/:id             profile + saved card
 *   GET  /customers/:id/charges     charge history
 *   POST /customers/:id/erase       dry_run:true reports, dry_run:false destroys
 *
 * Endpoint the agent does NOT see:
 *   POST /admin/reset               used by the seed script only
 */

import express from 'express';

const app = express();
app.use(express.json({ limit: '5mb' }));

/** @type {Map<string, any>} */
let customers = new Map();
let nextId = 1;
const audit = [];

function publicView(c) {
  return {
    id: c.id,
    email: c.email,
    name: c.name,
    payment_profile: c.card
      ? { brand: c.card.brand, last4: c.card.last4 }
      : null,
    charge_count: c.charges.length,
    erased: !!c.erased_at,
  };
}

app.get('/health', (_req, res) =>
  res.json({ ok: true, customers: customers.size }),
);

app.get('/customers', (req, res) => {
  const email = String(req.query.email || '').toLowerCase();
  if (!email)
    return res.status(400).json({ error: 'email query parameter is required' });
  const found = [...customers.values()].filter(
    (c) => c.email.toLowerCase() === email,
  );
  res.json({ query: email, results: found.map(publicView) });
});

app.get('/customers/:id', (req, res) => {
  const c = customers.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(publicView(c));
});

app.get('/customers/:id/charges', (req, res) => {
  const c = customers.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json({
    customer_id: c.id,
    charges: c.charges.map((ch, i) => ({
      id: `ch_${c.id}_${i}`,
      order_number: ch.order_number,
      amount_cents: ch.amount_cents,
      at: ch.at,
    })),
  });
});

/**
 * The destructive endpoint. dry_run defaults to true: you have to ask for
 * destruction explicitly, and the agent's approval gate sits on that flag.
 */
app.post('/customers/:id/erase', (req, res) => {
  const c = customers.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });

  const dryRun = req.body?.dry_run !== false;
  const effect = {
    customer_id: c.id,
    email: c.email,
    would_remove: {
      payment_profile: c.card ? 1 : 0,
      charges: c.charges.length,
      customer_record: 1,
    },
    reversible: false,
  };

  if (dryRun) return res.json({ dry_run: true, ...effect });

  if (c.erased_at)
    return res.status(409).json({ error: 'already erased', at: c.erased_at });

  const removed = { charges: c.charges.length, card: c.card ? 1 : 0 };
  c.card = null;
  c.charges = [];
  c.name = '[erased]';
  c.email = `erased+${c.id}@invalid`;
  c.erased_at = new Date().toISOString();

  audit.push({
    at: c.erased_at,
    customer_id: c.id,
    removed,
    case_id: req.body?.case_id ?? null,
    plan_hash: req.body?.plan_hash ?? null,
  });

  res.json({ dry_run: false, erased: true, ...effect, at: c.erased_at });
});

app.get('/admin/audit', (_req, res) => res.json({ audit }));

app.post('/admin/reset', (req, res) => {
  customers = new Map();
  nextId = 1;
  audit.length = 0;
  for (const c of req.body?.customers ?? []) {
    const id = `cus_${String(nextId++).padStart(5, '0')}`;
    customers.set(id, {
      id,
      email: c.email,
      name: c.name,
      card: c.card ?? null,
      charges: c.charges ?? [],
      erased_at: null,
    });
  }
  res.json({ ok: true, loaded: customers.size });
});

const port = Number(process.env.PORT || 4010);
app.listen(port, () => console.log(`billing-api listening on :${port}`));
