import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCallout} from '../src/callout.js';
test('callout default label is distinct from the stored custom title', () => {
  const empty = parseCallout('> [!todo]\n> 内容');
  assert.equal(empty.title, '待办'); assert.equal(empty.customTitle, '');
  const named = parseCallout('> [!todo]- 今天要做的事\n> 内容');
  assert.equal(named.title, '今天要做的事'); assert.equal(named.customTitle, named.title);
  assert.equal(named.fold, '-');
  assert.equal(parseCallout('> [!todo] 待办\n> 内容').customTitle, '待办');
});
