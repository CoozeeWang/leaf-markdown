import test from 'node:test';
import assert from 'node:assert/strict';
import {indexComments,planCommentInsertion,planCommentBody,planCommentDeletion,stripComments,maskHiddenComments,commentQuote} from '../src/comments.js';
import {parser} from '@lezer/markdown';
import {leafMarkdownExtensions} from '../src/markdown-extensions.js';
import {EditorState} from '@codemirror/state';
import {commentIndex} from '../src/comment-view.js';
const apply=(source,changes)=>[...changes].sort((a,b)=>b.from-a.from).reduce((text,c)=>text.slice(0,c.from)+(c.insert??'')+text.slice(c.to),source);
test('CriticMarkup ranges, points and Obsidian multiline comments retain source positions',()=>{
 const source='正文{==**范围**==}{>>批注<<}。{>>位置<<}\r\n\r\n%%\r\n隐注\r\n\r\n# 隐藏\r\n%%\r\n结束';
 const index=indexComments(source);assert.deepEqual(index.notes.map(n=>n.kind),['range','point','hidden']);assert.equal(index.notes[0].quote,'**范围**');
 assert.equal(source.slice(index.notes[2].from,index.notes[2].to),'%%\r\n隐注\r\n\r\n# 隐藏\r\n%%');
 assert.equal(maskHiddenComments(source).length,source.length);assert.equal(maskHiddenComments(source).split('\n').length,source.split('\n').length);
 assert.equal(stripComments(source),'正文**范围**。\r\n\r\n\r\n结束');
});
test('literal code, escapes, YAML and unclosed comments remain visible',()=>{
 const source='---\ntitle: "%%property%%"\n---\n\n`%%inline%%` \\%%escaped\\%%\n\n```md\n{>>code<<}\n```\n\n%%unclosed';
 assert.equal(indexComments(source).notes.length,0);assert.equal(stripComments(source),source);
});
test('range addition and deletion preserve formatting and actual body text',()=>{
 const source='正文 **粗体** 链接 [内容](https://example.com)。';const from=source.indexOf('**'),to=source.indexOf(' 链接');
 const plan=planCommentInsertion(source,from,to);assert.ok(plan.change);
 const added=apply(source,[plan.change]),note=indexComments(added).notes[0];assert.equal(note.kind,'range');
 const changed=apply(added,[planCommentBody(added,note,'依据')]);assert.ok(changed.includes('{>>依据<<}'));
 assert.equal(apply(changed,planCommentDeletion(changed,indexComments(changed).notes[0])),source);
 assert.equal(planCommentBody(added,note,'bad <<} terminator'),null);
});
test('unsupported selection rejects without converting or truncating it',()=>{
 assert.equal(planCommentInsertion('第一段\n\n第二段',0,9).error,'selection');
 assert.equal(planCommentInsertion('**粗体**',2,4).error,'selection');
 assert.equal(planCommentInsertion('`代码`',1,2).error,'selection');
 assert.equal(planCommentInsertion('a | b\n--|--\nc | d',0,5).error,'selection');
 const source='前{==范围==}{>>批注<<}后';assert.ok(planCommentInsertion(source,4,5).error);
 const long='文字'.repeat(400);assert.ok(planCommentInsertion(long,0,long.length).change);
 assert.equal(planCommentInsertion('literal ==} marker',0,18).error,'selection');
});
test('review revisions are opaque and preserved; range children keep Markdown semantics',()=>{
 const source='{++新增++} {--删除--} {~~旧~>新~~} {==**粗体**==}{>>批注<<}';
 assert.equal(indexComments(source).revisions.length,3);assert.equal(stripComments(source),'{++新增++} {--删除--} {~~旧~>新~~} **粗体**');
 const tree=parser.configure(leafMarkdownExtensions).parse(source);assert.ok(tree.toString().includes('CriticRange(CriticMark,StrongEmphasis'));assert.ok(tree.toString().includes('CriticRevision'));
});
test('deleting one adjacent point comment cannot reuse its identity for the next',()=>{
 let state=EditorState.create({doc:'{>>first<<}{>>second<<}',extensions:[commentIndex]});const before=state.field(commentIndex).notes;
 state=state.update({changes:{from:0,to:before[0].to,insert:''}}).state;
 assert.equal(state.field(commentIndex).notes[0].id,before[1].id);assert.notEqual(state.field(commentIndex).notes[0].id,before[0].id);
});
test('complete links can be annotated while URL fragments reject; excerpts are readable',()=>{
 const source='前 [链接](https://example.com) 后',from=source.indexOf('['),to=source.indexOf(')')+1;
 assert.ok(planCommentInsertion(source,from,to).change);assert.equal(planCommentInsertion(source,source.indexOf('https'),to-1).error,'selection');
 assert.equal(commentQuote('**粗体**和[链接](https://example.com)'),'粗体和链接');
 assert.equal(commentQuote('![图示](https://example.com/image.png)'),'图示');
 assert.equal(planCommentInsertion('# 标题',0,0).error,'position');assert.equal(planCommentInsertion('# 标题',1,1).error,'position');assert.ok(planCommentInsertion('# 标题',2,2).change);
 assert.equal(planCommentInsertion(source,from+2,from+2).error,'position');
 assert.equal(planCommentInsertion('{==已有高亮==}',5,5).error,'position');assert.ok(planCommentInsertion('{==已有高亮==}',10,10).change);
});
