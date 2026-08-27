import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oubliette-mcp-'));
process.env.OUBLIETTE_DB_PATH = path.join(directory, 'case.db');
const { createRealExecutionInterfaces, createServer } = await import('../src/mcp-server.js');
const { hashPlan } = await import('../src/plan.js');
const { createPostgresExecutor } = await import('../src/postgres-executor.js');

function fakePool() {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0 };
      return { rowCount: 1, rows: [{ id: 1 }] };
    },
    release() {},
  };
  return { calls, async connect() { return client; } };
}

 test('real MCP execution adapters invoke the destructive implementations', async () => {
  const plan = {
    case_id: 'mcp-case',
    actions: [
      { system: 'postgres', record_type: 'account', record_id: 7, disposition: 'erase' },
      { system: 'minio', record_type: 'object', record_id: 'uploads/7/avatar', locator: 'uploads/7/avatar', disposition: 'erase' },
      { system: 'billing', record_type: 'customer', record_id: 'cus_7', disposition: 'erase' },
    ],
    generated_at: '2025-01-01T00:00:00.000Z',
  };
  const planHash = hashPlan(plan);
  const removed = [];
  const erased = [];
  let receivedPlan;
  const interfaces = createRealExecutionInterfaces({
    postgresExecutor: { execute: async (value) => { receivedPlan = value; return { deleted: 1 }; } },
    minioClient: { removeObject: async (bucket, key) => removed.push([bucket, key]) },
    billingErase: async ({ customerId }) => erased.push(customerId),
  });

  await interfaces.database({ plan, case_id: plan.case_id, actions: plan.actions, withheld: [] });
  assert.deepEqual(receivedPlan.actions, plan.actions);
  await interfaces.minio({
    plan, planHash, approval: { plan_hash: planHash, approved: true },
    postgresPhase: { success: true }, withheld: [],
  });
  const result = await interfaces.billing({
    plan, planHash, caseId: plan.case_id, approvedBy: 'reviewer',
    approval: { plan_hash: planHash, approved_by: 'reviewer' }, postgresPhase: { success: true },
  });
  assert.deepEqual(removed, [['shopkart-uploads', 'uploads/7/avatar']]);
  assert.deepEqual(erased, ['cus_7']);
  assert.equal(result.ok, true);
});

test('default execution interfaces construct the sandbox adapter only when database execution starts', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const interfaces = createRealExecutionInterfaces();
    assert.doesNotThrow(() => createServer({ interfaces }));
    assert.throws(
      () => interfaces.database({ plan: { actions: [] }, withheld: [] }),
      /PostgreSQL deletion executor is sandbox-only/,
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('production MCP HTTP startup succeeds without constructing the sandbox adapter', async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  const child = spawn(process.execPath, ['src/mcp-server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      MCP_TRANSPORT: 'http',
      OUBLIETTE_MCP_PORT: String(port),
      OUBLIETTE_DB_PATH: path.join(directory, 'production-startup.db'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const startup = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP startup timed out: ${stderr}`)), 5000);
    child.stderr.on('data', () => {
      if (stderr.includes(`HTTP server listening at http://127.0.0.1:${port}/mcp`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`MCP exited before startup (${code ?? signal}): ${stderr}`));
    });
  });
  try {
    await startup;
    assert.equal(child.exitCode, null);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
  }
});

test('the database adapter translates orchestration withheld actions so the PostgreSQL withhold cross-check actually fires', async () => {
  const plan = { case_id: 'mcp-case-withhold', actions: [{ record_type: 'refund', record_id: 9 }] };
  const withheld = [{ system: 'postgres', record_type: 'refund', record_id: 9, disposition: 'retain', target: 'database' }];
  const pool = fakePool();
  const interfaces = createRealExecutionInterfaces({ postgresExecutor: createPostgresExecutor({ pool }) });

  await assert.rejects(
    interfaces.database({ plan, case_id: plan.case_id, actions: plan.actions, withheld }),
    /withheld record is not deletable/,
  );
  assert.equal(pool.calls.includes('BEGIN'), false);
});

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
