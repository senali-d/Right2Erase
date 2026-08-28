# Oubliette

A safety-first, multi-system erasure demo. ShopKart is a deterministic fake company; an agent must discover personal data across Postgres, MinIO, logs, and billing, preserve a live refund, and execute only a reviewed plan.

## Running the app

Requirements: Docker and Node.js 22.18+ (`npm test` runs a TypeScript test file
directly, which needs Node's built-in type stripping).

```bash
./scripts/setup.sh   # installs deps, starts Docker services, seeds ShopKart
npm run dev          # starts the 4 MCP servers and the control center
```

Open <http://localhost:3000>, enter `ravi.sharma@example.com`, and press
**Open erasure case**. The agent investigates all four systems, builds a plan,
rehearses it in a throwaway sandbox, and stops at the approval gate. Nothing is
deleted until you click **Approve & execute**.

`setup.sh` is a one-time step. After that, `npm run dev` is all you need.

### What each command starts

`./scripts/setup.sh` runs `npm install`, brings up `docker-compose.yml`
(Postgres `:5432`, MinIO `:9000`/`:9001`, the fake billing API `:4010`), and
seeds the fixture data.

`npm run dev` runs `scripts/dev-all.sh`, which starts five Node processes in one
terminal and shuts all of them down together if any one exits:

| Process | Port |
| --- | --- |
| Billing MCP adapter | 4011 |
| ShopKart database MCP adapter | 4012 |
| ShopKart storage MCP adapter | 4013 |
| Oubliette case management MCP | 4014 |
| Control center (Next.js) | 3000 |

All four MCP servers bind to `127.0.0.1`, so no `MCP_AUTH_TOKEN` is needed
locally. The browser never calls them directly; the Next.js server does.

Stop everything with Ctrl-C in that terminal. The Docker services keep running;
stop those with `npm run down`.

### Between demo takes

```bash
# stop npm run dev first: the Oubliette MCP server holds the case DB open,
# so clearing it while that process is alive has no effect on it
./scripts/demo-reset.sh
npm run dev
```

This re-seeds ShopKart and clears Oubliette's cases, run mirrors, and cached
ground-truth reports, so the same subject can be investigated again from
scratch. Cases are permanent audit records with no delete path, which is why
reopening one without a reset is refused.

### Troubleshooting

- **"cannot reach the Oubliette MCP server"** in the UI: an MCP server is not
  running. `npm run dev` starts all four; check its output for a port conflict.
- **"a case already exists for ..."**: expected. Open the existing case, or run
  `./scripts/demo-reset.sh` for a clean slate.
- **Port already in use**: something from a previous run survived. Check with
  `lsof -i :3000` (or 4011-4014) and stop it.
### Verifying the agent independently

`npm run truth` prints the expected manifest, derived straight from Postgres by
tooling the agent cannot reach. To score a real case against it:

```bash
node agent/build-plan-manifest.js <case_id> plan.json
npm run truth -- --diff plan.json
```

The control center shows the same comparison in its verification panel, so this
is the terminal equivalent of that screen.

Other useful scripts: `npm test` runs the full suite, `npm run web:build`
produces a production build, and `npm run reset` re-seeds ShopKart only.

## Repository

- `fixture/` - ShopKart fake services, schema, seed data, and operator-only truth checker
- `mcp/` - agent-facing MCP adapters for the fake services
- `web/` - the Data Erasure Control Center (Next.js)
- `docs/` - architecture, capability map, and Phase 0 evidence

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

## Data Erasure Control Center

`web/` is a Next.js UI over the same agent the CLI drives. It is one screen that
tells one story: who the subject is, where their data lives, what will be
deleted, what will not, whether the plan was actually tested, who authorized it,
and what happened.

The browser never talks to MCP. `mcp/http-transport.js` enforces an Origin
allowlist and serves no CORS headers, so every MCP call goes through Next.js
route handlers, which import `createAgent()` directly. The UI performs no
deletion of its own: approving calls `agent.executeApproved()`, and Oubliette
independently re-validates the canonical plan hash, the approving identity, and
the case revision before any adapter runs.

Live progress comes from `createAgent({ onToolCall })` - the agent has no events
of its own, so the UI derives its six phases from the tool names passing
through. The browser polls `/api/runs/<id>` once a second.

Two things are not in the case store and are tracked by `web/lib/run-store.ts`,
mirrored under `.oubliette/runs/`: the live phase, and the sandbox rehearsal
transcript, which `prepare()` returns and then discards. The rehearsal panel
shows both attempts - the seeded fixture deliberately fails the first on a
foreign-key violation and succeeds on the canonical-order retry.

The verification panel scores the case against `fixture/scripts/truth-core.js`,
which derives the correct answer straight from Postgres and is never reachable
by the agent. Its report is cached per case under `.oubliette/truth/`, because
after a successful erasure the subject's rows are gone and ground truth can no
longer be recomputed.

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
backs four ShopKart db tools:

- `db_export_subject_snapshot` copies one account and everything reachable
  from it (historical emails, orders, order items, settled refunds, support
  tickets, uploads, matching event-log rows, and referenced retained refunds)
  into a throwaway SQLite file under `OUBLIETTE_SANDBOX_DIR`
  (`.oubliette/sandbox` by default) that enforces the same foreign keys as
  production PostgreSQL. Every call writes a fresh, cryptographically unique
  file - never a deterministic per-account path - so concurrent exports for
  the same account (two overlapping investigations, a retry racing the
  original) can never overwrite or delete each other's snapshot. It returns
  an opaque `snapshot_id`, not the file's path.
- `db_rehearse_deletion_plan` and `db_delete_snapshot` both take that
  `snapshot_id`, never a path. Each server session keeps an in-memory map from
  id to the real file it exported, so these tools can only ever be pointed at
  a snapshot this process itself just wrote - not a client-supplied string, so
  a symlink placed inside the sandbox directory (by anything with local write
  access to it) has no id to be reached through. The path each id resolves to
  is still checked with `assertWithinSandbox` before use, which resolves
  symlinks (`fs.realpathSync`) and rejects anything that isn't a plain regular
  file, as defense in depth.
- `db_stage_deletion_actions` appends a chunk of planned delete actions
  (`MCP_DB_MAX_REHEARSAL_CHUNK`, default 5000, per call) to a snapshot's
  server-side pending list, up to `MCP_DB_MAX_STAGED_ACTIONS` (default
  200,000) staged actions total. Nothing is rehearsed by staging alone; call
  it once for a small account or repeatedly, in order, for a large one. This
  is what lets a large discovered account (thousands of order_items,
  event-log rows, etc.) stay preparable at all: the per-call cap only bounds
  one request's size, never the logical size of the rehearsal - splitting the
  transmission never splits or truncates the transaction that follows.
- `db_rehearse_deletion_plan` runs one transactional rehearsal over
  everything staged for a snapshot (it takes no actions of its own), inside a
  transaction it always rolls back, so rehearsal can never mutate the
  snapshot, let alone real ShopKart data. If the staged order hits a
  foreign-key violation, it retries once in the known leaf-to-root order and
  reports both attempts. Consumes what was staged either way.
- `db_delete_snapshot` removes a snapshot file. The agent calls this
  immediately after each account's rehearsal finishes, whether it passed or
  failed, so the exported PII copy never outlives the rehearsal it existed
  for.

The agent's `prepare()` calls export, stage (in `STAGE_CHUNK_SIZE`-sized
chunks), rehearse, and delete for every discovered account right after
`plan_create`, and refuses to return a plan for approval if rehearsal never
succeeds. In the seeded fixture this
exercises a real foreign-key failure and its auto-order retry: findings (and
therefore the plan's action order) record an account's orders before their
order items and refunds, so the first rehearsal attempt fails with `FOREIGN
KEY constraint failed` on an `order` row, and the canonical-order retry
succeeds. `src/postgres-executor.js` always deletes in its own fixed
leaf-to-root table order regardless of a plan's action order, so this
particular ordering mismatch can never itself reach real execution.
Rehearsal's actual safety value is proving, before any human ever approves a
plan, that every planned record still exists and every dependency resolves
cleanly against a foreign-key-enforced copy of the data - the same "record
not found" failure the real executor would otherwise only catch mid-deletion.
