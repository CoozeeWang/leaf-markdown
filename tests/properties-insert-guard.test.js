import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection, EditorState, StateEffect } from '@codemirror/state';
import { protectPropertyInsertions } from '../src/properties-insert-guard.js';
import { bodyStart, frontmatter } from '../src/markdown-model.js';

const source = '---\ntitle: Leaf\n---\n\nBody';
const floor = bodyStart(source);
const state = (doc = source) => EditorState.create({doc, extensions:[
  EditorState.allowMultipleSelections.of(true),
  EditorState.transactionFilter.of(protectPropertyInsertions),
]});

test('insertion transactions cannot prepend or partially replace properties', () => {
  for (const from of [0, 1, 4, floor - 1, floor]) {
    const tr = state().update({changes:{from,insert:'Image'},selection:{anchor:from+5},userEvent:'input.drop'});
    assert.equal(tr.newDoc.toString(), source.slice(0, floor) + 'Image' + source.slice(floor));
    assert.equal(tr.newSelection.main.head, floor + 5);
    assert.equal(tr.isUserEvent('input.drop'), true);
    assert.ok(frontmatter(tr.newDoc.toString()));
  }
  const tr = state().update({changes:{from:0,to:3,insert:'Paste'},selection:{anchor:5},userEvent:'input.paste'});
  assert.equal(tr.newDoc.toString(), source.slice(0, floor) + 'Paste' + source.slice(floor));
});

test('Backspace and partial deletions cannot consume the closing newline', () => {
  const tr = state().update({changes:{from:floor-1,to:floor},selection:{anchor:floor-1},userEvent:'delete.backward'});
  assert.equal(tr.newDoc.toString(), source);
  assert.equal(tr.newSelection.main.head, floor);
  const spanning = state().update({changes:{from:floor-2,to:source.length,insert:'New'},selection:{anchor:floor+1}});
  assert.equal(spanning.newDoc.toString(), source.slice(0,floor)+'New');
});

test('property-only documents gain a delimiter newline on insertion', () => {
  for (const closing of ['---', '...']) {
    const doc = '---\ntitle: Leaf\n'+closing;
    const tr = state(doc).update({changes:{from:doc.length,insert:'正文'},selection:{anchor:doc.length+2},userEvent:'input.type'});
    assert.equal(tr.newDoc.toString(), doc+'\n正文');
    assert.equal(tr.newSelection.main.head, doc.length+3);
    assert.ok(frontmatter(tr.newDoc.toString()));
  }
});

test('body edits, explicit property edits, full replacements and history keep their meaning', () => {
  for (const userEvent of ['input.properties', 'delete.properties', 'undo', 'redo']) {
    const tr = state().update({changes:{from:4,insert:'X'},userEvent});
    assert.equal(tr.newDoc.toString(), source.slice(0,4)+'X'+source.slice(4));
  }
  assert.equal(state().update({changes:{from:0,to:source.length,insert:'# Rewritten'}}).newDoc.toString(), '# Rewritten');
  assert.equal(state().update({changes:{from:0,to:floor,insert:''}}).newDoc.toString(), source.slice(floor));
  assert.equal(state().update({changes:{from:source.length,insert:'!'}}).newDoc.toString(), source+'!');
  const prose = '---\nThis is prose\n---\n';
  assert.equal(state(prose).update({changes:{from:0,insert:'X'}}).newDoc.toString(), 'X'+prose);
});

test('multiple insertions retain their selections and mapped effects', () => {
  const position = StateEffect.define({map:(value,mapping)=>mapping.mapPos(value,1)});
  const tr = state().update({
    changes:[{from:0,insert:'A'},{from:4,insert:'B'},{from:source.length,insert:'!'}],
    selection:EditorSelection.create([EditorSelection.cursor(1),EditorSelection.cursor(6),EditorSelection.cursor(source.length+3)],2),
    effects:position.of(source.length+3),
    userEvent:'input.drop', scrollIntoView:true,
  });
  assert.equal(tr.newDoc.toString(), source.slice(0,floor)+'AB'+source.slice(floor)+'!');
  assert.deepEqual(tr.newSelection.ranges.map(r=>r.head),[floor+1,floor+2,source.length+3]);
  assert.equal(tr.effects[0].value,source.length+3);
  assert.equal(tr.scrollIntoView,true);
});
