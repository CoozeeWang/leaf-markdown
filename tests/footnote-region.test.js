import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ChangeSet,EditorState} from '@codemirror/state';
import {indexFootnotes} from '../src/footnotes.js';
import {collectFootnoteDefinitions,continueBodyPosition,footnoteHiddenRanges} from '../src/footnote-region-model.js';
const collect=text=>ChangeSet.of(collectFootnoteDefinitions(text),text.length).apply(EditorState.create({doc:text}).doc).toString();
test('collect definitions after later prose, retaining complete multiline notes and body order',()=>{
 const original='第一段[^a]。\n\n[^a]: 第一段注释\n\n    第二段注释\n\n后来正文[^b]。\n\n[^b]: B\n\n最后正文。';
 const result=collect(original),index=indexFootnotes(result);
 assert.ok(result.indexOf('最后正文。')<result.indexOf('[^a]:'));
 assert.equal(index.notes.find(n=>n.id==='a').def.body,'第一段注释\n\n第二段注释');
 assert.ok(result.indexOf('第一段[^a]。')<result.indexOf('后来正文[^b]。'));
 assert.equal(collect(result),result);
});
test('collect does not replace or renumber Markdown and never treats fenced examples as notes',()=>{
 const original='```md\n[^fake]: example\n```\n\n正文[^named]。\n\n[^named]: **注释**\n\n正文尾';
 const result=collect(original);
 assert.ok(result.startsWith('```md\n[^fake]: example\n```'));
 assert.ok(result.endsWith('[^named]: **注释**'));
 assert.equal(indexFootnotes(result).definitions.length,1);
 assert.equal(collectFootnoteDefinitions('正文[^a]。\n\n[^a]: 注释').length,0);
});
test('body continuation sits before final definitions and hidden ranges do not swallow prose',()=>{
 const text='正文[^a]。\n\n[^a]: A\n\n尾段[^b]。\n\n[^b]: B';
 const doc=EditorState.create({doc:text}).doc,defs=indexFootnotes(text).definitions;
 assert.equal(continueBodyPosition(doc,defs),text.indexOf('\n\n[^b]:'));
 assert.equal(footnoteHiddenRanges(doc,defs).length,2);
 const final=collect(text),state=EditorState.create({doc:final});
 assert.equal(continueBodyPosition(state.doc,indexFootnotes(final).definitions),final.indexOf('尾段[^b]。')+'尾段[^b]。'.length);
});
