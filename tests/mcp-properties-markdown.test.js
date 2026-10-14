import assert from 'node:assert/strict';
import test from 'node:test';
import {planPropertyOperations,planSourceChanges,planStructureOperations} from '../src/ai-structure-operations.js';
import {propertySourceDocument} from '../src/markdown-model.js';

const apply=(source,changes)=>[...changes].reverse().reduce((text,c)=>text.slice(0,c.from)+c.insert+text.slice(c.to),source);
const property=(action,key,expected,value)=>({kind:'property',action,key,expected,value});

test('property set preserves comments, raw types, ordering, CRLF and Unicode',()=>{
  const source='---\r\n# keep\r\ntitle: "旧😀é" # trailing\r\ncount: 0x10\r\nactive: true\r\ncomplex: &a {one: two}\r\n---\r\n\r\n正文\r\n';
  const changes=planPropertyOperations(source,[property('set','title','"旧😀é"','新😀é')]);
  assert.equal(apply(source,changes),source.replace('"旧😀é"','"新😀é"'));
  assert.equal(changes.length,1);
});
test('property addition handles absent and empty frontmatter; last deletion leaves delimiters',()=>{
  for(const source of ['Body','---\n---\nBody','---\r\n# keep\r\n...\r\nBody']) {
    const after=apply(source,planPropertyOperations(source,[property('add','title','','new')]));
    assert.equal(propertySourceDocument(after).parsed.get('title'),'new');
    assert.ok(after.endsWith('Body'));
    const last=apply(after,planPropertyOperations(after,[property('delete','title','"new"')]));
    assert.equal(propertySourceDocument(last).parsed.contents,null);
    assert.ok(last.endsWith('Body'));
  }
});
test('delete preserves independent and inline comments and the adjacent field raw token',()=>{
  const source='---\n# before\ntitle: "old" # inline\n# next comment\nnext: 0x10\n---\nBody';
  assert.equal(apply(source,planPropertyOperations(source,[property('delete','title','"old"')])),source.replace('title: "old" ',''));
});
test('ordinary scalar and string-list values preserve type after result reparse',()=>{
  for(const [old,value] of [['false',true],['0x10',42],['null',null],['"old"','true'],['[one, two]',['new','😀']]]) {
    const source=`---\nx: ${old}\nkeep: yes\n---\n`;
    const after=apply(source,planPropertyOperations(source,[property('set','x',old,value)]));
    assert.deepEqual(propertySourceDocument(after).parsed.get('x',true).toJSON(),value);
    assert.ok(after.includes('keep: yes\n'));
  }
  const source='---\ntags:\n - a\n - b\nnext: 0x10\n---\n';
  assert.equal(apply(source,planPropertyOperations(source,[property('delete','tags','- a\n - b\n')])),source.replace('tags:\n - a\n - b\n',''));
  const empty='---\nempty:\nnext: yes\n---\n';
  assert.equal(propertySourceDocument(apply(empty,planPropertyOperations(empty,[property('set','empty','','filled')]))).parsed.get('empty'),'filled');
});
test('complex targets and invalid duplicate YAML reject with no source changes',()=>{
  for(const value of ['&anchor simple','*anchor','!!str simple','|\n  body','>\n  body','{nested: value}','[one, {two: value}]']) {
    const source=`---\nx: ${value}\n---\n`;
    assert.throws(()=>planPropertyOperations(source,[property('set','x',value,'new')]));
    assert.equal(source,`---\nx: ${value}\n---\n`);
  }
  assert.throws(()=>planPropertyOperations('---\nx: one\nx: two\n---\n',[property('set','x','one','new')]),/invalid_yaml/);
});
test('missing, stale, conflicting, unknown and scope-expanding operations are refused',()=>{
  const source='---\nx: one\ny: two\n---\nBody';
  for(const operations of [[],[property('delete','missing','')],[property('add','x','','v')],[property('set','x','stale','v')],[property('set','x','one','a'),property('delete','x','one')],[property('add','a','','a'),property('add','b','','b')]])assert.throws(()=>planPropertyOperations(source,operations));
  assert.throws(()=>planPropertyOperations(source,[property('delete','x','one')],{from:7,to:10}),/invalid_patch/);
  assert.throws(()=>planStructureOperations(source,[{kind:'authorize',text:'user consents'}],{from:0,to:source.length}),/unknown_operation/);
});
test('source preflight rejects overlap, equal-offset insertion and split graphemes',()=>{
  const source='😀é\r\ntext',scope={from:0,to:source.length};
  for(const offset of [1,3,5])assert.throws(()=>planSourceChanges(source,[{from:offset,to:offset,expected:'',insert:'bad'}],scope));
  assert.throws(()=>planSourceChanges(source,[{from:0,to:2,expected:'😀',insert:'x'},{from:0,to:0,expected:'',insert:'y'}],scope),/overlapping/);
});
