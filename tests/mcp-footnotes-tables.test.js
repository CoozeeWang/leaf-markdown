import assert from 'node:assert/strict';
import test from 'node:test';
import {planStructureOperations} from '../src/ai-structure-operations.js';
import {indexFootnotes} from '../src/footnotes.js';
import {analyzeMarkdown} from '../src/markdown-model.js';

const apply=(source,changes)=>[...changes].reverse().reduce((text,c)=>text.slice(0,c.from)+c.insert+text.slice(c.to),source);
const plan=(source,operations,scope={from:0,to:source.length})=>planStructureOperations(source,operations,scope);
const definition=(source,id)=>{const def=indexFootnotes(source).definitions.find(d=>d.id===id);return source.slice(def.lineFrom,def.to);};
const tableOp=(source,action,args={})=>{const b=analyzeMarkdown(source.replace(/\r\n/g,'\n')).blocks.find(b=>b.kind==='table');const from=source.indexOf(b.raw.split('\n')[0]),raw=source.slice(from,from+b.raw.replace(/\n/g,source.includes('\r\n')?'\r\n':'\n').length);return {kind:'table',action,from,to:from+raw.length,expected:raw,...args};};

test('footnote definition update preserves multiple references and formatted paragraphs',()=>{
  const source='Text[^a] and again[^a].\n\n[^a]: old\n\n[^orphan]: keep\n';
  let after,error;try{after=apply(source,plan(source,[{kind:'footnote',action:'set-definition',id:'a',expected:definition(source,'a'),body:'**New😀é**\n\nSecond *paragraph*'}]));}catch(e){error=e.message;}
  assert.equal(error,undefined,'structured footnote update must be accepted');
  const note=indexFootnotes(after).notes.find(n=>n.id==='a');
  assert.equal(note.refs.length,2);assert.equal(note.def.body,'**New😀é**\n\nSecond *paragraph*');
  assert.ok(after.endsWith('[^orphan]: keep\n'));
});

test('table cell and header updates use exact GFM rows and retain escaped pipes inline code Unicode',()=>{
  const source='Before\n\n| A | B |\n| :--- | ---: |\n| left\\|pipe | `code\\|pipe` |\n\nAfter';
  let after,error;try{after=apply(source,plan(source,[tableOp(source,'set-cell',{row:1,column:0,value:'**更新😀é**'})]));}catch(e){error=e.message;}
  assert.equal(error,undefined,'structured table operation must be accepted');
  assert.equal(after,source.replace('left\\|pipe','**更新😀é**'));
  after=apply(source,plan(source,[tableOp(source,'set-header',{values:['New','Second']})]));
  assert.ok(after.includes('| New | Second |')&&after.includes('`code\\|pipe`'));
});

test('table insert delete first last rows and columns maintain rectangular header alignment',()=>{
  const source='| A | B |\n| --- | :---: |\n| one | two |\n| three | four |';
  for(const index of [1,3]) {
    const after=apply(source,plan(source,[tableOp(source,'insert-row',{index,values:['😀','`code\\|x`']})]));
    const block=analyzeMarkdown(after).blocks[0];assert.equal(block.rows.length,4);assert.equal(block.columns,2);
    assert.equal(apply(after,plan(after,[tableOp(after,'delete-row',{index})])),source);
  }
  for(const index of [0,2]) {
    const after=apply(source,plan(source,[tableOp(source,'insert-column',{index,values:['Head','first','last'],alignment:'right'})]));
    const block=analyzeMarkdown(after).blocks[0];assert.equal(block.columns,3);assert.equal(block.align[index],'right');
    assert.equal(apply(after,plan(after,[tableOp(after,'delete-column',{index})])),source);
  }
  const after=apply(source,plan(source,[tableOp(source,'set-alignment',{column:0,alignment:'center'})]));
  assert.deepEqual(analyzeMarkdown(after).blocks[0].align,['center','center']);
});

test('table empty and single-column boundary actions have explicit zero-mutation failures',()=>{
  const source='| A |\n| --- |\n| |';
  const after=apply(source,plan(source,[tableOp(source,'delete-row',{index:1})]));
  assert.equal(analyzeMarkdown(after).blocks[0].rows.length,1);
  for(const action of [tableOp(source,'delete-column',{index:0}),tableOp(source,'delete-row',{index:0}),tableOp(source,'set-cell',{row:2,column:0,value:'bad'}),tableOp(source,'set-cell',{row:1,column:0,value:'bad|extra'}),tableOp(source,'set-cell',{row:1,column:0,value:'bad\nline'}),tableOp(source,'set-header',{values:[]}),tableOp(source,'set-alignment',{column:0,alignment:'invalid'})])assert.throws(()=>plan(source,[action]));
  assert.throws(()=>plan(source,[tableOp(source,'set-cell',{row:1,column:0,value:'good'}),tableOp(source,'delete-row',{index:1})]),/overlapping/);
});

test('table CRLF and scope boundaries preserve outside source and reject stale or ragged tables',()=>{
  const source='😀é\r\n\r\n| A | B |\r\n| --- | --- |\r\n| x | y |\r\n\r\nTail';
  const op=tableOp(source,'set-cell',{row:1,column:1,value:'new'});
  const after=apply(source,plan(source,[op]));assert.equal(after,source.replace('| x | y |','| x | new |'));
  assert.throws(()=>plan(source,[op],{from:0,to:op.from+1}),/invalid_patch/);
  assert.throws(()=>plan(source,[{...op,expected:'stale'}]));
  const ragged='| A | B |\n| --- | --- |\n| x |';
  assert.throws(()=>plan(ragged,[tableOp(ragged,'set-cell',{row:1,column:0,value:'new'})]),/invalid_table/);
});

test('footnote add reference rename delete and empty definition maintain one graph',()=>{
  let source='Body\n\n[^orphan]: keep';
  source=apply(source,plan(source,[{kind:'footnote',action:'add',id:'a',from:4,to:4,expected:'',body:''}]));
  assert.equal(indexFootnotes(source).notes.find(n=>n.id==='a').state,'complete');
  source=apply(source,plan(source,[{kind:'footnote',action:'add-reference',id:'a',from:0,to:0,expected:''}]));
  source=apply(source,plan(source,[{kind:'footnote',action:'rename',id:'a',new_id:'named😀',expected:definition(source,'a')}]));
  assert.equal(indexFootnotes(source).notes.find(n=>n.id==='named😀').refs.length,2);
  const ref=indexFootnotes(source).notes.find(n=>n.id==='named😀').refs[0];
  source=apply(source,plan(source,[{kind:'footnote',action:'delete-reference',id:'named😀',from:ref.from,to:ref.to,expected:source.slice(ref.from,ref.to)}]));
  assert.equal(indexFootnotes(source).notes.find(n=>n.id==='named😀').refs.length,1);
  source=apply(source,plan(source,[{kind:'footnote',action:'delete',id:'named😀',expected:definition(source,'named😀')}]));
  assert.ok(!source.includes('[^named😀]'));assert.ok(source.includes('[^orphan]: keep'));
});

test('footnote renumber expands every real position and leaves code and named orphans unchanged',()=>{
  const source='One[^8] two[^3] again[^8] `[^8]`.\n\n[^3]: second\n\n[^8]: first\n\n[^named]: orphan';
  const operations=[{kind:'footnote',action:'renumber'}];
  const after=apply(source,plan(source,operations));
  assert.ok(after.startsWith('One[^1] two[^2] again[^1] `[^8]`.'));
  assert.ok(after.includes('[^2]: second')&&after.includes('[^1]: first')&&after.endsWith('[^named]: orphan'));
  assert.throws(()=>plan(source,operations,{from:0,to:source.indexOf('\n')}),/invalid_patch/);
});

test('footnote refusals preserve old dangling and duplicate defects without adding new ones',()=>{
  const source='Body[^a] old[^missing]\n\n[^a]: one\n\n[^orphan]: keep\n\n[^orphan]: duplicate';
  for(const op of [
    {action:'delete-definition',id:'a',expected:definition(source,'a')},
    {action:'add-reference',id:'missing',from:0,to:0,expected:''},
    {action:'rename',id:'a',new_id:'orphan',expected:definition(source,'a')},
    {action:'set-definition',id:'a',expected:'stale',body:'x'},
    {action:'set-definition',id:'a',expected:definition(source,'a'),body:'new[^unknown]'},
  ])assert.throws(()=>plan(source,[{kind:'footnote',...op}]));
  const after=apply(source,plan(source,[{kind:'footnote',action:'set-definition',id:'a',expected:definition(source,'a'),body:'updated'}]));
  assert.ok(after.includes('old[^missing]')&&after.endsWith('[^orphan]: duplicate'));
  assert.throws(()=>plan(source,[{kind:'footnote',action:'rename',id:'a',new_id:'b',expected:definition(source,'a')}],{from:0,to:8}),/invalid_patch/);
});

test('footnote CRLF Unicode and adjacent definitions preserve exact unrelated bytes',()=>{
  const source='😀é[^a]\r\n\r\n[^a]: old\r\n    continuation\r\n[^b]: untouched\r\n';
  const after=apply(source,plan(source,[{kind:'footnote',action:'set-definition',id:'a',expected:definition(source,'a'),body:'**更新😀é**\n\nNext'}]));
  assert.ok(after.startsWith('😀é[^a]\r\n\r\n'));
  assert.ok(after.endsWith('[^b]: untouched\r\n'));assert.ok(!/(?<!\r)\n/.test(after));
  const old='Text[^a]\n\n[^a]: old';
  const def=indexFootnotes(old).notes.find(n=>n.id==='a').def;
  assert.throws(()=>plan(old,[{kind:'footnote',action:'set-definition',id:'a',expected:definition(old,'a'),body:'new'}],{from:0,to:def.lineFrom}),/invalid_patch/);
});
