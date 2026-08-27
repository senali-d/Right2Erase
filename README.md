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
`plan_create` → human `plan_approve` → `certificate_record`.

## Read-only discovery MCPs

The database and storage adapters expose discovery only; every tool is
annotated `readOnlyHint: true` and neither adapter has write or delete tools.
Run them over stdio for a local connector or HTTP for TrueForge:

```bash
npm run mcp:db:http       # http://127.0.0.1:4012/mcp
npm run mcp:storage:http  # http://127.0.0.1:4013/mcp
```

The billing adapter remains separate at `http://127.0.0.1:4011/mcp`; its
`billing_erase_customer` tool is the only destructive operation and requires
the approved plan hash at execution time.
