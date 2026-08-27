-- ShopKart demo fixture schema
--
-- Deliberately shaped to make erasure non-trivial:
--   * order_items and refunds hang off orders, orders hang off accounts,
--     so deletion has a required order (leaf -> root).
--   * pending refunds are moved to retained_refunds, a detached legal-retention
--     model that survives deletion of the customer hierarchy.
--   * account_emails keeps historical addresses, so identity resolution has
--     to follow a chain rather than matching one string.
--   * uploads.account_id is nullable; some rows are only linkable via the
--     object key, which forces a real search instead of a join.
--   * event_log has no foreign key at all. It is matched on email or IP.

DROP TABLE IF EXISTS retained_refunds CASCADE;
DROP TABLE IF EXISTS refunds CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS support_tickets CASCADE;
DROP TABLE IF EXISTS uploads CASCADE;
DROP TABLE IF EXISTS account_emails CASCADE;
DROP TABLE IF EXISTS event_log CASCADE;
DROP TABLE IF EXISTS accounts CASCADE;
DROP TABLE IF EXISTS erasure_certificates CASCADE;

CREATE TABLE accounts (
    id            SERIAL PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    full_name     TEXT NOT NULL,
    country       TEXT NOT NULL,
    last_seen_ip  INET,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Historical + current addresses. Discovery must walk this to find records
-- filed under an address the customer no longer uses.
CREATE TABLE account_emails (
    id          SERIAL PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES accounts(id),
    email       TEXT NOT NULL,
    is_primary  BOOLEAN NOT NULL DEFAULT false,
    valid_from  TIMESTAMPTZ NOT NULL,
    valid_until TIMESTAMPTZ
);

CREATE TABLE orders (
    id            SERIAL PRIMARY KEY,
    account_id    INTEGER NOT NULL REFERENCES accounts(id),
    order_number  TEXT NOT NULL UNIQUE,
    total_cents   INTEGER NOT NULL,
    status        TEXT NOT NULL,           -- placed | shipped | delivered | returned
    ship_address  TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE order_items (
    id           SERIAL PRIMARY KEY,
    order_id     INTEGER NOT NULL REFERENCES orders(id),
    sku          TEXT NOT NULL,
    product_name TEXT NOT NULL,
    qty          INTEGER NOT NULL,
    price_cents  INTEGER NOT NULL
);

-- Settled refunds are ordinary order records and may be erased with the order.
CREATE TABLE refunds (
    id            SERIAL PRIMARY KEY,
    order_id      INTEGER NOT NULL REFERENCES orders(id),
    amount_cents  INTEGER NOT NULL,
    status        TEXT NOT NULL,           -- settled
    reason        TEXT NOT NULL,
    opened_at     TIMESTAMPTZ NOT NULL,
    settled_at    TIMESTAMPTZ NOT NULL,
    CHECK (status = 'settled')
);

-- Live financial obligations are retained without a foreign key to the
-- customer hierarchy. source_order_number is a non-PII audit reference; the
-- customer account and order can therefore be deleted safely.
CREATE TABLE retained_refunds (
    id                  SERIAL PRIMARY KEY,
    source_order_number TEXT NOT NULL,
    amount_cents        INTEGER NOT NULL,
    reason              TEXT NOT NULL,
    opened_at            TIMESTAMPTZ NOT NULL,
    retained_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE support_tickets (
    id          SERIAL PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES accounts(id),
    subject     TEXT NOT NULL,
    body        TEXT NOT NULL,
    status      TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL
);

-- account_id is nullable on purpose: legacy rows exist where the only link
-- back to a person is the object key path.
CREATE TABLE uploads (
    id          SERIAL PRIMARY KEY,
    account_id  INTEGER REFERENCES accounts(id),
    object_key  TEXT NOT NULL UNIQUE,
    kind        TEXT NOT NULL,             -- avatar | return_receipt | id_document
    bytes       INTEGER NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL
);

-- No foreign key. Personal data leaks in here as email and IP.
CREATE TABLE event_log (
    id          BIGSERIAL PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL,
    email       TEXT,
    ip_address  INET,
    method      TEXT NOT NULL,
    path        TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    user_agent  TEXT NOT NULL
);

-- Written by the agent after an approved execution. Never deleted.
CREATE TABLE erasure_certificates (
    id             SERIAL PRIMARY KEY,
    case_id        TEXT NOT NULL UNIQUE,
    subject_email  TEXT NOT NULL,
    plan_hash      TEXT NOT NULL,
    approved_by    TEXT NOT NULL,
    approved_at    TIMESTAMPTZ NOT NULL,
    executed_at    TIMESTAMPTZ NOT NULL,
    manifest       JSONB NOT NULL,
    withheld       JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX ON orders (account_id);
CREATE INDEX ON order_items (order_id);
CREATE INDEX ON refunds (order_id);
CREATE INDEX ON support_tickets (account_id);
CREATE INDEX ON uploads (account_id);
CREATE INDEX ON event_log (email);
CREATE INDEX ON event_log (ip_address);
CREATE INDEX ON account_emails (email);
