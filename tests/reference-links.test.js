import test from 'node:test';
import assert from 'node:assert/strict';
import { parser } from '@lezer/markdown';
import { Text } from '@codemirror/state';
import { referenceLinks, referenceTarget } from '../src/reference-links.js';
test('reference definitions normalize labels, keep first definition, exclude code and footnotes',()=>{
 const source='[  My  link ]: https://example.invalid/first\n[my link]: https://example.invalid/second\n\n[^note]: https://example.invalid/note\n\n```md\n[code]: https://example.invalid/code\n```';
 const doc=Text.of(source.split('\n')), refs=referenceLinks(doc);
 assert.deepEqual([...refs.map],[['my link','https://example.invalid/first']]);
 assert.equal(referenceLinks(doc),refs);
 for(const text of ['[Words][MY link]','[My link][]','[My link]']) {
  const node=parser.parse(text).topNode.firstChild.firstChild;
  assert.equal(referenceTarget(node,text,refs),'https://example.invalid/first');
 }
 assert.notEqual(referenceLinks(doc.replace(0,0,Text.of(['new','']))),refs);
});
