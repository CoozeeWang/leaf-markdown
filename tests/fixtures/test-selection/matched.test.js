import test from 'node:test';
import assert from 'node:assert/strict';
test('selection fixture passes', () => assert.equal(2 + 2, 4));
test('selection fixture fails', () => assert.equal(2 + 2, 5));
