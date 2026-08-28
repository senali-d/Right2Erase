# Oubliette

A safety-first, multi-system erasure demo. ShopKart is a deterministic fake company; an agent must discover personal data across Postgres, MinIO, logs, and billing, preserve a live refund, and execute only a reviewed plan.

## Quick start

Requirements: Docker and Node.js 20+.

```bash
./scripts/setup.sh
# or: npm run setup
npm run truth
```

Reset between demo takes:

```bash
./scripts/demo-reset.sh
```

## Repository

- `fixture/` — ShopKart fake services, schema, seed data, and operator-only truth checker
- `mcp/` — agent-facing MCP adapters for the fake services
- `docs/` — architecture, capability map, and Phase 0 evidence

## Qodo Code Review Evidence

Qodo reviewed PR #1 (ShopKart fixture). The review and remediation history are
available in the GitHub PR: https://github.com/senali-d/Right2Erase/pull/1

## Existing compatibility commands

From `fixture/`: `npm run up`, `npm run seed`, `npm run truth`, `npm run reset`, and `npm run mcp:billing:http` remain available. From the repository root, use `make mcp-billing-http` to start the billing MCP adapter.

## Oubliette case database

Phase 1 now includes a durable SQLite case-management MCP server in `src/`. It stores
cases, findings, immutable plan versions and hashes, approvals, and execution
certificates; it does not perform source-system deletion.

```bash
npm run mcp:oubliette              # stdio
MCP_TRANSPORT=http npm run mcp:oubliette:http  # http://127.0.0.1:4014/mcp
```

The database defaults to `.oubliette/oubliette.db` and can be relocated with
`OUBLIETTE_DB_PATH`. The intended workflow is `case_create` → `finding_add` →
`plan_create` → human `plan_approve` → `oubliette_execute_erasure`. The execution
tool is the sole destructive Oubliette entry point: it revalidates the canonical
hash, approval identity, current revision, and withholds before calling injected
database, MinIO, and billing interfaces. Those interfaces intentionally refuse
until deployment wiring supplies safe, transactional adapters.

## Read-only discovery MCPs

The database and storage adapters expose discovery only; every tool is
annotated `readOnlyHint: true` and neither adapter has write or delete tools.
Run them over stdio for a local connector or HTTP for TrueForge:

```bash
npm run mcp:db:http       # http://127.0.0.1:4012/mcp
npm run mcp:storage:http  # http://127.0.0.1:4013/mcp
```

The billing adapter remains separate at `http://127.0.0.1:4011/mcp` and exposes
read-only discovery plus dry-run preview. Billing deletion is reached only
through Oubliette's approved execution path.

## TrueForge agent

Start the four HTTP MCP servers, then prepare an investigation plan with:

```bash
node agent/create-agent.js customer@example.com
```

The agent investigates through read-only tools, records findings, creates and
rehearses a plan, and stops for human approval. Only an explicit approval lets
it call `oubliette_execute_erasure`; the result includes the verification
certificate. Server URLs and the approval policy are documented in
`trueforge.config.json` and can be overridden with environment variables.

Sandbox MinIO execution is isolated in `src/minio-executor.js`. It accepts no
free-form object list: keys are derived only from erase actions in a hash-
validated, approved plan, withheld keys are rejected, and PostgreSQL must report
`{ success: true }` before the injected fixture client is called. The executor
returns per-object results and requested/deleted/failed counts. The discovery
adapter remains read-only; production clients are never constructed by this
path.

## Sandbox rehearsal

Before a plan ever reaches a human, `prepare()` rehearses it. `mcp/snapshot.js`
backs two ShopKart db tools:

- `db_export_subject_snapshot` copies one account and everything reachable
  from it (historical emails, orders, order items, settled refunds, support
  tickets, uploads, matching event-log rows, and referenced retained refunds)
  into a throwaway SQLite file under `OUBLIETTE_SANDBOX_DIR`
  (`.oubliette/sandbox` by default) that enforces the same foreign keys as
  production PostgreSQL.
- `db_rehearse_deletion_plan` tries an ordered list of deletes against that
  snapshot inside a transaction it always rolls back, so rehearsal can never
  mutate the snapshot, let alone real ShopKart data. If the given order hits a
  foreign-key violation, it retries once in the known leaf-to-root order and
  reports both attempts.

The agent's `prepare()` calls both for every discovered account right after
`plan_create` and refuses to return a plan for approval if rehearsal never
succeeds. In the seeded fixture this genuinely catches a real ordering
mistake: findings (and therefore the plan's action order) record an account's
orders before their order items and refunds, so the first rehearsal attempt
fails with `FOREIGN KEY constraint failed` on an `order` row, and the
canonical-order retry succeeds.
