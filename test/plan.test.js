import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeletionPlan } from '../src/plan.js';

const target = (record_id, disposition = 'erase') => ({
  system: 'billing', record_type: 'customer', record_id, disposition,
});

const check = (plan, manifest = [], withheld = []) =>
  validateDeletionPlan(plan, manifest, withheld);

test('accepts a valid plan and preserves retained targets', () => {
  const erase = target('cus-1');
  const retain = target('refund-1', 'retain');
  const plan = { case_id: 'case-1', actions: [erase, retain] };

  assert.equal(check(plan, [erase], [retain]), plan);
});

test('rejects duplicate targets in actions and collections', () => {
  const erase = target('cus-1');
  assert.throws(() => check({ actions: [erase, { ...erase }] }), /duplicate or overlapping/);
  assert.throws(() => check({ actions: [erase] }, [erase, { ...erase }]), /duplicate manifest/);
});

test('rejects a target present in both delete and withhold collections', () => {
  const erase = target('cus-1');
  const retain = target('cus-1', 'retain');
  assert.throws(() => check({ actions: [erase] }, [erase], [retain]), /both deleted and withheld/);
});

test('rejects malformed entries and mismatched collections', () => {
  assert.throws(() => check({ actions: [{ record_id: '1', disposition: 'erase' }] }), /malformed action/);
  assert.throws(() => check({ actions: [target('cus-1')] }, [{ ...target('cus-2') }]), /does not match/);
  assert.throws(() => check({ actions: [target('cus-1')] }, [target('cus-1')], [null]), /malformed withheld/);
});

test('accepts empty plans only with empty collections and supports numeric ids', () => {
  assert.doesNotThrow(() => check({ actions: [] }));
  assert.throws(() => check({ actions: [] }, [target('unexpected')]), /does not match/);
  const numeric = target(42);
  assert.doesNotThrow(() => check({ actions: [numeric] }, [numeric], []));
});
