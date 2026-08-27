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
