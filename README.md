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
- `docs/` — architecture and capability map

## Existing compatibility commands

From `fixture/`: `npm run up`, `npm run seed`, `npm run truth`, `npm run reset`, and `npm run mcp:billing:http` remain available. From the repository root, use `make mcp-billing-http` to start the billing MCP adapter.
