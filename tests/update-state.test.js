import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeUpdateSnapshot } from '../src/update-state.js';
test('a late snapshot cannot replace a newer native event', () => {
  const current = {state_revision: 4, op_id: 2, state: 'available'};
  assert.equal(mergeUpdateSnapshot(current, {state_revision: 3, op_id: 1, state: 'checking'}), current);
});
test('duplicate revisions and malformed revisions are ignored', () => {
  const current = {state_revision: 4};
  for (const incoming of [{state_revision: 4}, {state_revision: -1}, {}, null]) {
    assert.equal(mergeUpdateSnapshot(current, incoming), current);
  }
});
test('newer native state is projected', () => {
  const incoming = {state_revision: 5, op_id: 3, state: 'checking'};
  assert.equal(mergeUpdateSnapshot({state_revision: 4}, incoming), incoming);
});
