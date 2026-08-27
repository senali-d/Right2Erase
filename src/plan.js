import { createHash } from 'node:crypto';

// Stable JSON makes the same reviewed plan produce the same audit hash.
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashPlan(plan) {
  return createHash('sha256').update(canonicalize(plan)).digest('hex');
}

// The execution certificate calls these collections manifest and withheld. A
// target is identified by the same durable tuple used by findings; mutable
// fields (for example a locator) must not affect safety checks.
function targetKey(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  const { system, record_type: recordType, record_id: recordId } = target;
  const validId = (typeof recordId === 'string' && recordId.length > 0)
    || (typeof recordId === 'number' && Number.isFinite(recordId));
  if (typeof system !== 'string' || system.length === 0
      || typeof recordType !== 'string' || recordType.length === 0 || !validId) return null;
  return JSON.stringify([system, recordType, String(recordId)]);
}

/**
 * Validate the reviewed actions before an orchestrator can perform deletion.
 * The returned value is intentionally the input plan, so callers can use this
 * as a guard without changing their existing certificate data.
 */
export function validateDeletionPlan(plan, manifest = [], withheld = []) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !Array.isArray(plan.actions)) {
    throw new Error('invalid deletion plan: actions must be an array');
  }
  if (!Array.isArray(manifest) || !Array.isArray(withheld)) {
    throw new Error('invalid deletion plan: manifest and withheld must be arrays');
  }

  const plannedDelete = new Set();
  const plannedWithhold = new Set();
  for (const action of plan.actions) {
    const key = targetKey(action);
    if (!key) throw new Error('invalid deletion plan: malformed action target');
    if (!['erase', 'retain', 'review'].includes(action.disposition)) {
      throw new Error('invalid deletion plan: malformed action disposition');
    }
    const collection = action.disposition === 'erase' ? plannedDelete : plannedWithhold;
    if (plannedDelete.has(key) || plannedWithhold.has(key)) {
      throw new Error('invalid deletion plan: duplicate or overlapping action target');
    }
    collection.add(key);
  }

  const readCollection = (items, name) => {
    const keys = new Set();
    for (const item of items) {
      const key = targetKey(item);
      if (!key) throw new Error(`invalid deletion plan: malformed ${name} target`);
      if (keys.has(key)) throw new Error(`invalid deletion plan: duplicate ${name} target`);
      keys.add(key);
    }
    return keys;
  };
  const deleteTargets = readCollection(manifest, 'manifest');
  const withheldTargets = readCollection(withheld, 'withheld');
  for (const key of deleteTargets) {
    if (withheldTargets.has(key)) throw new Error('invalid deletion plan: target is both deleted and withheld');
  }

  const sameTargets = (actual, expected) => actual.size === expected.size
    && [...actual].every((key) => expected.has(key));
  if (!sameTargets(deleteTargets, plannedDelete)) {
    throw new Error('invalid deletion plan: manifest does not match erase actions');
  }
  if (!sameTargets(withheldTargets, plannedWithhold)) {
    throw new Error('invalid deletion plan: withheld does not match retained actions');
  }
  return plan;
}

export const validatePlan = validateDeletionPlan;

export function buildPlan({ case_id, findings }) {
  const actions = findings.map((finding) => ({
    system: finding.system,
    record_type: finding.record_type,
    record_id: finding.record_id,
    locator: finding.locator ?? null,
    disposition: finding.disposition,
  }));
  return { case_id, actions, generated_at: new Date().toISOString() };
}
