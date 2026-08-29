#!/usr/bin/env node
/**
 * Drive one real erasure case through the TrueForge agent and print what it did.
 *
 * Operator tooling, not part of the app: it is the fastest way to see whether
 * the agent reaches the approval gate at all, without the UI in the way.
 *
 *   node scripts/trueforge-smoke.mjs [subject-email]
 */
import { TrueForge } from '@truefoundry/trueforge-sdk';

const subject = process.argv[2] || 'ravi.sharma@example.com';
const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL || 'http://localhost:8790',
  timeoutInSeconds: 900,
});

const { data: session } = await client.sessions.create({ agent: { name: 'oubliette-erasure' } });
console.log(`session ${session.id}\nsubject ${subject}\n`);

const counts = new Map();
let approvalRequired = null;
let caseId = null;

const stream = await client.sessions.createTurnStream(session.id, {
  input: [{ type: 'user.message', content: `Handle a right-to-erasure request for ${subject}.` }],
});

for await (const { data: event } of stream.withMetadata()) {
  if (event.type === 'model.message' && event.toolCalls?.length) {
    for (const call of event.toolCalls) {
      const name = call.toolInfo?.name ?? 'unknown';
      counts.set(name, (counts.get(name) || 0) + 1);
      process.stdout.write(`\r${[...counts.values()].reduce((a, b) => a + b, 0)} tool calls  (latest: ${name})          `);
      if (name === 'case_create') caseId = call.id;
    }
  }
  if (event.type === 'tool.approval_required') approvalRequired = event;
  if (event.type === 'turn.done') console.log(`\n\nturn: ${event.state.status}`);
}

console.log('\ntool calls by name:');
for (const [name, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${name}`);
}

if (approvalRequired) {
  console.log('\nPAUSED FOR APPROVAL — the agent reached the gate and stopped.');
  console.log(`  pending tool calls: ${approvalRequired.toolCalls.length}`);
} else {
  console.log('\nNo approval was requested. Either the run failed before the gate, or it never planned an erasure.');
}
if (caseId) console.log(`\ncase_create was called (tool call ${caseId}).`);
