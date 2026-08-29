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

## Deploying

The whole demo ships as **one container**: Postgres, MinIO, the billing API, the
four MCP adapters, the TrueForge harness, and the Next.js control center, all on
loopback. That is not packaging convenience. `src/postgres-executor.js` and
`src/minio-executor.js` refuse to delete anything whose host is not `localhost`,
and refuse to run at all when `NODE_ENV=production`. Splitting the stores across
managed services would mean weakening the guards this project exists to
demonstrate, so instead the deployment satisfies them.

```bash
docker build -t oubliette .
docker run --rm -p 3000:3000 -e OPENAI_API_KEY=sk-... -v oubliette-state:/data oubliette
```

First boot runs `initdb` and seeds 200 ShopKart accounts, so give it a minute or
two before the UI answers.

### On Railway

`railway.json` builds from the `Dockerfile` and health-checks `/`. Create one
service from this repo, attach a **volume mounted at `/data`**, and set a single
variable:

```
OPENAI_API_KEY=sk-...
```

Everything else has a working default in `scripts/railway-entrypoint.sh`. If
`OPENAI_API_KEY` is missing the container still boots and still demos: it logs a
warning, skips the TrueForge harness, and falls back to the deterministic
engine, which drives the same MCP servers through the same approval gate.

Two variables are worth knowing about because setting them incorrectly breaks
the demo rather than degrading it:

- **Do not set `NODE_ENV`.** `next start` sets its own; exporting `production` to
  the whole container disarms both destructive executors, and **Approve &
  execute** fails with `sandbox-only`.
- **Do not set `MCP_AUTH_TOKEN`.** All four adapters stay on `127.0.0.1`, which
  is the case `mcp/http-transport.js` lets through without one.

Only `/data` is persistent, and it holds one thing: Oubliette's SQLite audit
trail - cases, plans, approvals, and the immutable erasure certificates. It
survives redeploys. ShopKart itself is reseeded on every boot, which is both
free (the seed is deterministic, so the data comes back identical) and necessary
(the billing API keeps its customers in memory and only the seed populates it).
The rehearsal sandbox is deliberately *not* on the volume: those files are
complete copies of a subject's personal data, and a crash should leave them on a
disk that dies with the container.

Sizing, measured on the built image: **~400 MB idle** with everything including
TrueForge, **~500 MB peak** while a case runs, and ~335 MB if the harness is
skipped. That fits Railway's Trial (1 GB, $5 one-time credit) with room to
spare. It does not fit the Free plan: the 0.5 GB ceiling is below the measured
peak, and the $1/month credit funds about four days of uptime regardless. At
Trial rates the $5 covers roughly a month of idle hosting, so deploy near the
day you need it. Railway's serverless sleep will not stretch that - the `pg`
pools hold a connection open, which is exactly what keeps a service awake.

The four MCP servers run as one process in the container
(`scripts/mcp-all.js`) rather than the four `npm run dev` starts, which buys
back ~110 MB of idle V8 heaps. Nothing else about them differs.

### Between demo takes, deployed

```bash
railway ssh -- /app/scripts/railway-reset.sh
```

This clears Oubliette's state and restarts the container, which reseeds
ShopKart. It is the deployed equivalent of `./scripts/demo-reset.sh`, and it
exists for the same reason: cases are permanent audit records, so a subject who
already has one cannot be investigated again until the case store is cleared.

## Repository

- `fixture/` - ShopKart fake services, schema, seed data, and operator-only truth checker
- `mcp/` - agent-facing MCP adapters for the fake services
- `agent/` - both engines: the deterministic script (`trueforge-agent.js`, `create-agent.js`) and the TrueForge agent definition (`oubliette-agent.json`)
- `src/` - Oubliette: the case store, plans, approvals, and the sole destructive path
- `web/` - the Data Erasure Control Center (Next.js)
- `docs/` - architecture, capability map, and Phase 0 evidence
- `Dockerfile`, `railway.json`, `scripts/railway-*.sh` - the single-container deployment

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
route handlers. The UI performs no deletion of its own, on either engine:
Oubliette independently re-validates the canonical plan hash, the approving
identity, and the case revision before any adapter runs.

Live progress is derived from tool names, since neither engine emits phases of
its own. On the agentic engine they come off the TrueForge event stream
(`web/lib/trueforge-runs.ts`); on the deterministic one from an `onToolCall`
observer (`web/lib/agent-runs.ts`). `web/lib/engine.ts` chooses between them and
the routes call only that. The browser polls `/api/runs/<id>` once a second.

Two things are not in the case store and are tracked by `web/lib/run-store.ts`,
mirrored under `.oubliette/runs/`: the live phase, and the sandbox rehearsal
transcript. The rehearsal panel
shows both attempts - the seeded fixture deliberately fails the first on a
foreign-key violation and succeeds on the canonical-order retry.

The verification panel scores the case against `fixture/scripts/truth-core.js`,
which derives the correct answer straight from Postgres and is never reachable
by the agent. Its report is cached per case under `.oubliette/truth/`, because
after a successful erasure the subject's rows are gone and ground truth can no
longer be recomputed.

## The agent, and the two engines

The investigation can be driven two ways. Both call the same MCP servers, so
they have identical safety properties - the guarantees live in the adapters,
not in whichever engine is calling.

- **`agentic`** (default) - an LLM on the [TrueForge](https://trueforge.dev)
  harness decides what to search, what to record, and what to withhold.
  TrueForge runs the loop and owns the approval pause.
- **`deterministic`** - the original fixed script in `agent/`. Kept as the
  oracle for "is this the model or the plumbing?", and as a one-flag fallback.

Pick per request with `{"engine": "deterministic"}` on `POST /api/cases`, or
set `OUBLIETTE_ENGINE` to change the default.

### Running the agentic engine

```bash
cp .env.example .env                   # then put your OPENAI_API_KEY in .env
npx @truefoundry/trueforge@latest      # the harness, on :8790
node --env-file=.env scripts/trueforge-bootstrap.mjs
```

Bootstrap registers the four MCP servers, the agent, and - if `OPENAI_API_KEY`
is set - the model provider, so the TrueForge UI is never required. It is
idempotent: re-run it after editing `agent/oubliette-agent.json`.

The key is read from the environment and handed to TrueForge, which keeps it in
its own settings. Nothing in this repo writes it to disk, and `.env` is
gitignored. If the agent's model is already configured the script leaves the
provider untouched rather than overwriting it, so a hand-configured TrueForge
keeps its other models.

`node scripts/trueforge-smoke.mjs [email]` drives one case straight through the
harness and prints what the agent did, without the UI in the way.

### Why the adapters refuse instead of truncating

Handing the loop to a model changed what the MCP layer has to guarantee. When
the caller was a fixed script, several correctness properties lived in that
script by convention. They are now enforced where a caller cannot route around
them:

- `finding_add` records a `retained_refund` as **retained** whatever
  disposition is passed, and `plan_create` refuses a plan that claims to delete
  one. Preserving live financial obligations is the point of the system; it was
  previously a convention the caller happened to follow.
- `system` and `record_type` are **closed enums**. They decide which executor a
  record routes to and which table it is deleted from, and the retention rule
  matches `record_type` exactly - so free text let an agent name things its own
  way and silently slip past all three.
- `db_find_accounts` refuses an email matching more than one account. People
  share names and addresses get recycled; erasing the wrong person is
  unrecoverable.
- `case_complete_discovery` refuses a case with no findings.
- Storage listings and `db_get_account_emails` **fail rather than return a
  partial set**. A short result is indistinguishable from a complete one, and
  planning from one silently leaves data behind.
- `db_search_event_log` batches internally, and `finding_add_many` records a
  whole result set in one call - a real subject has hundreds of records, and
  one call per row is how an investigation runs out of patience and stops
  early.

`src/db.test.js`, `src/mcp-server.test.js`, and `mcp/database-server.test.js`
drive these directly, with no agent involved: they are the proof that safety
does not depend on the model behaving well.

## TrueForge agent (deterministic engine)

Start the four HTTP MCP servers, then prepare an investigation plan with:

```bash
node agent/create-agent.js customer@example.com
```

The agent investigates through read-only tools, records findings, creates and
rehearses a plan, and stops for human approval. Only an explicit approval lets
it call `oubliette_execute_erasure`; the result includes the verification
certificate. Server URLs come from `MCP_SERVERS` in
`agent/trueforge-agent.js` and can be overridden with environment variables.

For the agentic engine the equivalent configuration is
`agent/oubliette-agent.json` - the model, the instructions, which MCP servers
are attached, and which tools require approval - applied to the harness by
`scripts/trueforge-bootstrap.mjs`.

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
