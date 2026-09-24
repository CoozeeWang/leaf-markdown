import {test} from 'node:test';
import assert from 'node:assert/strict';
import {frontmatter} from '../src/markdown-model.js';
import {convertProperty,propertySource,today} from '../src/property-types.js';
test('typed values preserve standard YAML and safe conversion',()=>{
 assert.equal(convertProperty('','date'),today());
 assert.equal(convertProperty('false','checkbox'),false);
 assert.throws(()=>convertProperty('草稿','checkbox'));
 assert.throws(()=>convertProperty('not a number','number'));
 const yaml=frontmatter('---\nitems: ["a", "b"]\ndone: false\ncount: 4\n---');
 assert.deepEqual(yaml.fields.map(f=>f.value),[['a','b'],false,4]);
});
test('block list replacement preserves following fields; commented lists remain raw',()=>{
 const doc='---\nitems:\n  - a\n  - b\nnext: yes\n---\n# 正文';
 const f=frontmatter(doc).fields[0],raw=doc.slice(f.from,f.to);
 const updated=doc.slice(0,f.from)+propertySource(['c'])+(raw.endsWith('\n')?'\n':'')+doc.slice(f.to);
 assert.deepEqual(frontmatter(updated).fields.map(f=>f.value),[['c'],'yes']);
 assert.equal(frontmatter('---\na:\n - x # keep\n---').fields[0].editable,false);
});
