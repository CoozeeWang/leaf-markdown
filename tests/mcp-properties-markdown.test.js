import assert from 'node:assert/strict';
import test from 'node:test';
import {planPropertyOperations,planMarkdownRangeOperations,planSourceChanges,planStructureOperations,verifyStructureResult} from '../src/ai-structure-operations.js';
import {planMcpCommentBatch} from '../src/ai-comment-operations.js';
import {propertySourceDocument} from '../src/markdown-model.js';
import {parseMarkdown} from '../src/markdown-parse.js';

const apply=(source,changes)=>[...changes].reverse().reduce((text,c)=>text.slice(0,c.from)+c.insert+text.slice(c.to),source);
const property=(action,key,expected,value)=>({kind:'property',action,key,expected,value});

test('final YAML union rejects malformed and duplicate keys and verifies requested property semantics',()=>{
  const source='---\nx: old\ny: good\n---\n\nBody',scope={from:0,to:source.length},operations=[property('set','x','old','new')];
  const structures=planStructureOperations(source,operations,scope,{deferIntegrity:true}).map(c=>({...c,expected:source.slice(c.from,c.to)}));
  for(const patch of [
    {from:source.indexOf('good'),to:source.indexOf('good')+4,expected:'good',insert:'['},
    {from:source.indexOf('y:'),to:source.indexOf('y:')+1,expected:'y',insert:'x'},
    {from:source.indexOf('x:'),to:source.indexOf('x:')+1,expected:'x',insert:'z'},
  ]) {
    const union=planSourceChanges(source,[...structures,patch],scope);
    assert.throws(()=>verifyStructureResult(source,union,operations),/invalid_yaml_result|invalid_property_result/);
    assert.throws(()=>planMcpCommentBatch(source,{changes:[patch],operations:[...operations,{kind:'comment',action:'add',from:source.indexOf('Body'),to:source.length,expected:'Body',text:'Synthetic'}]},{document_id:'document',session_id:'session',revision:0,authorization_epoch:1,source_fingerprint:'synthetic',scope}),/invalid_yaml_result|invalid_property_result/);
  }
  const valid=planSourceChanges(source,[...structures,{from:source.indexOf('good'),to:source.indexOf('good')+4,expected:'good',insert:'better'}],scope);
  verifyStructureResult(source,valid,operations);
  assert.equal(apply(source,valid),'---\nx: "new"\ny: better\n---\n\nBody');
});

test('unrelated unsupported and pre-existing invalid YAML retain their raw boundary',()=>{
  for(const yaml of ['complex: &keep {nested: raw}','broken: [']) {
    const source=`---\n${yaml}\n---\n\nBody`,at=source.indexOf('Body');
    const planned=planStructureOperations(source,[{kind:'markdown',from:at,to:at+4,expected:'Body',insert:'Updated'}],{from:0,to:source.length});
    assert.equal(apply(source,planned),source.replace('Body','Updated'));
  }
});

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
  const raw='Body\r\n';
  assert.equal(apply(raw,planPropertyOperations(raw,[property('add','label','','new')])),'---\r\n"label": "new"\r\n---\r\n\r\nBody\r\n');
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

test('Markdown ranges use actual Leaf CommonMark GFM and extension parse with unchanged outside source',()=>{
  const prefix='---\r\nname: Synthetic\r\n---\r\n\r\n',target='# Old\r\n\r\nPlain😀é\r\n\r\n- item\r\n\r\n> quote\r\n\r\n```js\r\nold()\r\n```\r\n\r\n[link](https://example.invalid/old)\r\n',suffix='\r\n![image](synthetic.png)\r\n\r\n[^1]: footnote\r\n\r\n{==range==}{>>comment<<} %%hidden%% ==highlight==\r\n\r\n| A | B |\r\n| --- | --- |\r\n| one | two |\r\n';
  const source=prefix+target+suffix,edits=[['# Old','# New'],['Plain😀é','**Bold😀é**'],['- item','- [x] task'],['> quote','> updated'],['old()','new()'],['https://example.invalid/old','https://example.invalid/new']];
  const operations=edits.map(([expected,insert])=>({kind:'markdown',from:source.indexOf(expected),to:source.indexOf(expected)+expected.length,expected,insert}));
  const after=apply(source,planMarkdownRangeOperations(source,operations));
  assert.ok(after.startsWith(prefix)&&after.endsWith(suffix));
  // Actual Leaf syntax consumes the LF buffer; disk CRLF is metadata, retained
  // above byte-for-byte by the pure planner and covered by the editor below.
  const names=new Set();parseMarkdown(after.replace(/\r\n/g,'\n')).iterate({enter:node=>{names.add(node.name);}});
  for(const name of ['ATXHeading1','StrongEmphasis','BulletList','Task','Blockquote','FencedCode','Link','Image','Table','CriticRange','CriticComment','LeafHighlight'])assert.ok(names.has(name),`actual syntax: ${name}`);
  assert.ok(after.includes('new()\r\n'));
});
test('Markdown empty source, whole single node, missing source, overlap and adjacent structures',()=>{
  assert.equal(apply('',planMarkdownRangeOperations('',[{from:0,to:0,expected:'',insert:'# New\n'}])),'# New\n');
  assert.deepEqual(planMarkdownRangeOperations('one',[{from:0,to:3,expected:'one',insert:'one'}]),[]);
  assert.equal(apply('one',planMarkdownRangeOperations('one',[{from:0,to:3,expected:'one',insert:''}])),'');
  assert.throws(()=>planMarkdownRangeOperations('one',[{from:0,to:3,expected:'missing',insert:'x'}]),/invalid_patch/);
  const source='Body\n\n# Outside\n\n![image](synthetic.png)\n';
  assert.throws(()=>planMarkdownRangeOperations(source,[{from:0,to:4,expected:'Body',insert:'```'}]),/markdown_structure_outside_range/);
  assert.throws(()=>planMarkdownRangeOperations(source,[{from:0,to:4,expected:'Body',insert:'A'},{from:2,to:4,expected:'dy',insert:'B'}]),/overlapping/);
  assert.throws(()=>planMarkdownRangeOperations('---\nx: one\n---\nBody',[{from:7,to:10,expected:'one',insert:'two'}]),/markdown_property_range/);
});
test('mixed property and Markdown operations share original coordinates and reject union collisions',()=>{
  const source='---\nx: one\n---\n\n# Old\n';
  const operations=[property('set','x','one','two'),{kind:'markdown',from:source.indexOf('Old'),to:source.indexOf('Old')+3,expected:'Old',insert:'New'}];
  assert.equal(apply(source,planStructureOperations(source,operations,{from:0,to:source.length})),source.replace('one','"two"').replace('Old','New'));
});
