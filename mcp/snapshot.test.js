import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertWithinSandbox, deleteSnapshot, rehearseDeletionPlan, resolveSandboxDir, sandboxSnapshotPath, writeSubjectSnapshot,
} from './snapshot.js';

function tempSandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oubliette-sandbox-'));
}

function seedSnapshot(dbPath) {
  return writeSubjectSnapshot({
    dbPath,
    tables: {
      accounts: [{ id: 1, email: 'ravi@example.com', full_name: 'Ravi Sharma', country: 'IN', last_seen_ip: null, created_at: '2024-01-01T00:00:00.000Z' }],
      orders: [{ id: 10, account_id: 1, order_number: 'ORD-1', total_cents: 1000, status: 'delivered', ship_address: 'addr', created_at: '2024-01-02T00:00:00.000Z' }],
      order_items: [{ id: 100, order_id: 10, sku: 'SK-1', product_name: 'Shirt', qty: 1, price_cents: 1000 }],
      refunds: [{ id: 200, order_id: 10, amount_cents: 500, status: 'settled', reason: 'return', opened_at: '2024-01-03T00:00:00.000Z', settled_at: '2024-01-04T00:00:00.000Z' }],
    },
  });
}

test('writeSubjectSnapshot creates a fresh SQLite file with foreign keys enforced', () => {
  const dir = tempSandbox();
  try {
    const dbPath = path.join(dir, 'account-1.db');
    const counts = seedSnapshot(dbPath);
    assert.equal(counts.accounts, 1);
    assert.equal(counts.orders, 1);
    assert.equal(counts.order_items, 1);
    assert.equal(counts.refunds, 1);
    assert.ok(fs.existsSync(dbPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rehearseDeletionPlan reports a foreign-key violation when the order is wrong', () => {
  const dir = tempSandbox();
  try {
    const dbPath = path.join(dir, 'account-1.db');
    seedSnapshot(dbPath);

    // Wrong order: the order still has order_items and refunds pointing at it.
    const outcome = rehearseDeletionPlan({
      dbPath,
      actions: [{ record_type: 'order', record_id: 10 }, { record_type: 'order_item', record_id: 100 }, { record_type: 'refund', record_id: 200 }],
      autoOrder: false,
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.attempts.length, 1);
    assert.equal(outcome.attempts[0].order, 'as_planned');
    assert.match(outcome.attempts[0].error, /FOREIGN KEY/i);
    assert.deepEqual(outcome.attempts[0].failed_action, { record_type: 'order', record_id: 10 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rehearseDeletionPlan self-corrects to the leaf-to-root order when auto_order is on', () => {
  const dir = tempSandbox();
  try {
    const dbPath = path.join(dir, 'account-1.db');
    seedSnapshot(dbPath);

    const outcome = rehearseDeletionPlan({
      dbPath,
      actions: [{ record_type: 'order', record_id: 10 }, { record_type: 'order_item', record_id: 100 }, { record_type: 'refund', record_id: 200 }],
      autoOrder: true,
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.attempts.length, 2);
    assert.equal(outcome.attempts[0].ok, false);
    assert.equal(outcome.attempts[1].order, 'canonical_leaf_to_root');
    assert.equal(outcome.attempts[1].ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rehearsal never keeps its deletes: rows still exist in the snapshot after a successful rehearsal', () => {
  const dir = tempSandbox();
  try {
    const dbPath = path.join(dir, 'account-1.db');
    seedSnapshot(dbPath);

    rehearseDeletionPlan({
      dbPath,
      actions: [{ record_type: 'order_item', record_id: 100 }, { record_type: 'refund', record_id: 200 }, { record_type: 'order', record_id: 10 }],
      autoOrder: false,
    });

    const outcome = rehearseDeletionPlan({
      dbPath,
      actions: [{ record_type: 'order_item', record_id: 100 }, { record_type: 'refund', record_id: 200 }, { record_type: 'order', record_id: 10 }],
      autoOrder: false,
    });
    assert.equal(outcome.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteSnapshot removes a sandbox file and is a no-op if it is already gone', () => {
  const dir = tempSandbox();
  try {
    const dbPath = path.join(dir, 'account-1.db');
    seedSnapshot(dbPath);
    assert.ok(fs.existsSync(dbPath));

    deleteSnapshot(dbPath);
    assert.ok(!fs.existsSync(dbPath));
    assert.doesNotThrow(() => deleteSnapshot(dbPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sandboxSnapshotPath stays inside the sandbox directory and assertWithinSandbox accepts it', () => {
  const dir = tempSandbox();
  try {
    const dbPath = sandboxSnapshotPath(7, dir);
    assert.equal(path.dirname(dbPath), resolveSandboxDir(dir));
    assert.equal(assertWithinSandbox(dbPath, dir), path.resolve(dbPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertWithinSandbox rejects a path escaping the sandbox directory', () => {
  const dir = tempSandbox();
  try {
    assert.throws(() => assertWithinSandbox('/etc/passwd', dir), /outside the sandbox directory/);
    assert.throws(() => assertWithinSandbox(path.join(dir, '..', 'escaped.db'), dir), /outside the sandbox directory/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
