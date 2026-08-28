import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResult } from './create-agent.js';

test('parseResult unwraps a text content block into JSON', () => {
  const value = parseResult({ content: [{ type: 'text', text: '{"case_id":"case-1"}' }] });
  assert.deepEqual(value, { case_id: 'case-1' });
});

test('parseResult returns non-JSON text as a plain string', () => {
  assert.equal(parseResult({ content: [{ type: 'text', text: 'not json' }] }), 'not json');
});

// An MCP tool failure is a normal response carrying isError, not a thrown
// transport error. Treating it as data let a failed finding_add look like a
// successful one, so discovery could "complete" over silently dropped records.
test('parseResult throws on an MCP error result instead of returning it as data', () => {
  assert.throws(
    () => parseResult({ isError: true, content: [{ type: 'text', text: 'case not found: case-9' }] }),
    /case not found: case-9/,
  );
});

test('parseResult throws a fallback message when an error result carries no text', () => {
  assert.throws(() => parseResult({ isError: true, content: [] }), /MCP tool call failed/);
});
