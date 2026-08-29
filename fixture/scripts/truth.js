#!/usr/bin/env node
/**
 * Ground truth for the fixture.
 *
 * Computes, independently of the agent, exactly what a correct erasure for a
 * given subject should touch. Use it two ways:
 *
 *   npm run truth                    # print the expected manifest
 *   npm run truth -- --diff plan.json  # compare the agent's plan against it
 *
 * This file is NOT reachable by the agent. It exists so you can prove your
 * discovery actually discovered things rather than being told the answers.
 * Keep it out of the agent's MCP surface. The computation itself lives in
 * truth-core.js so the operator UI can render the same manifest.
 */

import { readFile } from 'node:fs/promises';
import {
  computeTruth,
  DEFAULT_DATABASE_URL,
  DEFAULT_SUBJECT_EMAIL,
} from './truth-core.js';

const DB = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
const subjectEmail = process.env.SUBJECT_EMAIL || DEFAULT_SUBJECT_EMAIL;

const diffIndex = process.argv.indexOf('--diff');
const planPath = diffIndex > -1 ? process.argv[diffIndex + 1] : null;

function walk(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v))
      Object.assign(out, walk(v, `${prefix}${k}.`));
    else out[`${prefix}${k}`] = v;
  }
  return out;
}

const expected = await computeTruth({
  connectionString: DB,
  email: subjectEmail,
});

if (!planPath) {
  console.log(JSON.stringify(expected, null, 2));
  process.exit(0);
}

const plan = JSON.parse(await readFile(planPath, 'utf8'));
const e = walk(expected.delete);
const actualDelete = plan.delete;
const g = walk(
  actualDelete &&
    typeof actualDelete === 'object' &&
    !Array.isArray(actualDelete)
    ? actualDelete
    : {},
);
let bad = 0;

console.log('\n  key                        expected   agent');
console.log('  ' + '-'.repeat(46));
for (const k of Object.keys(e)) {
  const ok = e[k] === g[k];
  if (!ok) bad++;
  console.log(
    `  ${ok ? '✓' : '✗'} ${k.padEnd(24)} ${String(e[k]).padStart(6)}  ${String(g[k] ?? '—').padStart(6)}`,
  );
}

// A matching set of counts is not enough: an extra target can make an unsafe
// plan look valid.  The delete manifest is deliberately a closed set.
const expectedDeleteKeys = new Set(Object.keys(e));
const actualDeleteKeys = Object.keys(g);
const unexpectedDeleteKeys = actualDeleteKeys.filter(
  (k) => !expectedDeleteKeys.has(k),
);
if (
  unexpectedDeleteKeys.length ||
  !actualDelete ||
  Array.isArray(actualDelete) ||
  typeof actualDelete !== 'object'
) {
  bad++;
  console.log(
    `  ✗ unexpected delete target(s): ${
      unexpectedDeleteKeys.join(', ') || '(delete must be an object)'
    }`,
  );
}

// Compare retained refunds by their durable identity, not by position or
// array length.  This catches both a substituted record and duplicate entries.
const identity = (record) =>
  record && record.table != null && record.id != null
    ? `${record.table}:${record.id}`
    : null;
const expectedWithhold = new Set(expected.withhold.map(identity));
const actualWithhold = Array.isArray(plan.withhold) ? plan.withhold : [];
const actualWithholdIds = actualWithhold.map(identity);
const actualWithholdSet = new Set(actualWithholdIds);
const duplicateWithholdIds = actualWithholdIds.filter(
  (id, i) => id === null || actualWithholdIds.indexOf(id) !== i,
);
const missingWithholdIds = [...expectedWithhold].filter(
  (id) => !actualWithholdSet.has(id),
);
const unexpectedWithholdIds = [...actualWithholdSet].filter(
  (id) => !expectedWithhold.has(id),
);
const withheldOk =
  Array.isArray(plan.withhold) &&
  duplicateWithholdIds.length === 0 &&
  missingWithholdIds.length === 0 &&
  unexpectedWithholdIds.length === 0;
if (!withheldOk) bad++;
console.log(
  `  ${withheldOk ? '✓' : '✗'} withheld records         ${String(expectedWithhold.size).padStart(6)}  ${String(actualWithholdSet.size).padStart(6)}`,
);
if (missingWithholdIds.length)
  console.log(
    `  ✗ missing withheld target(s): ${missingWithholdIds.join(', ')}`,
  );
if (unexpectedWithholdIds.length)
  console.log(
    `  ✗ unexpected withheld target(s): ${unexpectedWithholdIds.join(', ')}`,
  );
if (duplicateWithholdIds.length)
  console.log(
    `  ✗ duplicate/invalid withheld target(s): ${duplicateWithholdIds.join(', ')}`,
  );

const swept = (actualDelete?.account_ids || []).filter((id) =>
  expected.must_not_touch.some((c) => c.id === id),
);
if (swept.length) {
  bad++;
  console.log(`  ✗ SWEEPS COLLIDING ACCOUNT: ${swept.join(', ')}`);
}

console.log(
  bad === 0 ? '\n  plan matches ground truth\n' : `\n  ${bad} mismatch(es)\n`,
);
process.exit(bad === 0 ? 0 : 1);
