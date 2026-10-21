import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';

let api={};
try {api=await import('../src/ai-comment-operations.js');} catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const fingerprint=source=>createHash('sha256').update(source).digest('hex');
const context=source=>({document_id:'document-synthetic',session_id:'session-synthetic',revision:7,authorization_epoch:2,source_fingerprint:fingerprint(source),scope:{from:0,to:source.length}});

test('fixed revision comment queries distinguish adjacent repeated quotes, points and hidden source',async()=>{
  assert.equal(typeof api.listAiComments,'function','authorized comment query API must exist');
  const source=await readFile(new URL('./fixtures/mcp-comments.md',import.meta.url),'utf8');
  const ctx=context(source),result=api.listAiComments(source,ctx);
  assert.deepEqual(result.comments.map(n=>n.kind),['range','range','point','hidden']);
  assert.equal(new Set(result.comments.map(n=>n.id)).size,4);
  assert.deepEqual(api.listAiComments(source,ctx),result);
  for(const note of result.comments){
    assert.equal(note.source,source.slice(note.from,note.to));
    assert.equal(api.readAiComment(source,ctx,note.id).comment.text,note.text);
    assert.deepEqual(api.locateAiComment(source,ctx,note.id).range,note.anchor);
  }
  assert.equal(api.readAiComment(source,ctx,'unknown').comment,null);
  assert.equal(api.locateAiComment(source,ctx,'unknown').range,null);
  assert.deepEqual(api.listAiComments('',context('')).comments,[]);
  assert.equal(api.readAiComment(source,{...ctx,revision:8},result.comments[0].id).comment,null);
  const scoped=api.listAiComments(source,{...ctx,scope:{from:result.comments[1].from,to:result.comments[1].to}});
  assert.deepEqual(scoped.comments.map(n=>n.id),[result.comments[1].id]);
});

test('comment query route uses the authorized live renderer bridge and fixed revision',async()=>{
  const main=await readFile(new URL('../src/main.js',import.meta.url),'utf8');
  const rust=await readFile(new URL('../src-tauri/src/mcp.rs',import.meta.url),'utf8');
  assert.ok(main.includes('handleMcpCommentQuery'),'production renderer must serve comment queries');
  for(const name of ['list_comments','read_comment','locate_comment'])assert.ok(rust.includes(`"${name}"`),`${name} must be discoverable through the broker`);
  assert.ok(rust.includes('"comment_query"'),'query must reach existing Tauri bridge');
  const handler=main.slice(main.indexOf('async function handleMcpCommentQuery'),main.indexOf('\nconst welcome'));
  const source='Unsaved {>>live😀<<}',ctx=context(source);
  const runtime={editor:{mcpSnapshot:()=>({content:source,revision:7})},mcpBinding:ctx,mcpDigest:async text=>fingerprint(text),...api};
  const serve=vm.runInNewContext(`${handler};handleMcpCommentQuery`,runtime);
  const args={...ctx,query:'list_comments'};
  const reply=await serve(args);assert.equal(reply.comments[0].text,'live😀');
  await assert.rejects(serve({...args,revision:6}),/stale_revision/);
  await assert.rejects(serve({...args,session_id:'retired'}),/not_authorized/);
  runtime.mcpDigest=async text=>{runtime.mcpBinding={...ctx,authorization_epoch:3};return fingerprint(text);};
  await assert.rejects(serve(args),/stale_revision/);
});

const apply=(source,changes)=>changes.reduceRight((text,c)=>text.slice(0,c.from)+c.insert+text.slice(c.to),source);
test('comment mutation union preserves CRLF Unicode body and hidden format, rejects ambiguity before edits',()=>{
  assert.equal(typeof api.planMcpCommentBatch,'function','comment operations must share original-snapshot atomic preflight');
  const source='---\r\ntitle: "Old"\r\n---\r\n\r\n{==**重复😀é**==}{>>one<<}{==重复😀é==}{>>two<<} end{>>point<<}.\r\n\r\n%%hidden\r\n\r\nliteral%%\r\n\r\nPlain😀é end.';
  const ctx=context(source),notes=api.listAiComments(source,ctx).comments;
  const op=(note,action,text)=>({kind:'comment',action,id:note.id,source_fingerprint:note.source_fingerprint,expected:note.source,...(text===undefined?{}:{text})});
  const from=source.indexOf('Plain'),to=from+'Plain😀é'.length;
  const operations=[op(notes[0],'delete'),op(notes[1],'set',''),op(notes[3],'set','new\r\n\r\nliteral'),{kind:'comment',action:'add',from,to,expected:source.slice(from,to),text:'中文😀é'}, {kind:'property',action:'set',key:'title',expected:'"Old"',value:'New'}];
  const changes=api.planMcpCommentBatch(source,{operations},ctx);
  assert.deepEqual(api.planMcpCommentBatch(source,{operations:[...operations].reverse()},ctx),changes);
  const after=apply(source,changes);assert.ok(after.includes('**重复😀é**{==重复😀é==}{>><<} end{>>point<<}'));
  assert.ok(after.includes('%%new\r\n\r\nliteral%%'));assert.ok(after.includes('{==Plain😀é==}{>>中文😀é<<}'));
  assert.equal(after.replace(/[^\n]/g,'').length,source.replace(/[^\n]/g,'').length);
  const point={kind:'comment',action:'add',from:source.length,to:source.length,expected:'',text:''};
  assert.ok(apply(source,api.planMcpCommentBatch(source,{operations:[point]},ctx)).endsWith('{>><<}'));
  for(const invalid of [
    {...point,comment_kind:'hidden'}, {...point,text:'bad<<}'}, {...point,from:from+6,to:from+6}, {...point,from:from+8,to:from+8},
    {...op(notes[0],'set','bad'),source_fingerprint:'stale'}, {...op(notes[0],'delete'),expected:'stale'}, {...op(notes[0],'delete'),id:'unknown'},
    {...op(notes[3],'set','bad%%')}, {...point,from:0,to:0}, {...point,from:notes[0].anchor.from,to:notes[0].anchor.from}
  ])assert.throws(()=>api.planMcpCommentBatch(source,{operations:[invalid]},ctx));
  assert.throws(()=>api.planMcpCommentBatch(source,{operations:[point,point]},ctx),/overlapping/);
  assert.throws(()=>api.planMcpCommentBatch(source,{operations:[op(notes[0],'delete')],changes:[{from:notes[0].from,to:notes[0].to,expected:notes[0].source,insert:'bad'}]},ctx),/overlapping/);
  assert.throws(()=>api.planMcpCommentBatch(source,{operations:[op(notes[0],'delete')]},{...ctx,revision:8}),/comment_missing/);
  assert.throws(()=>api.planMcpCommentBatch(source,{operations:[op(notes[0],'delete')]},{...ctx,scope:{from:notes[0].anchor.from,to:source.length}}),/comment_missing/);
});

test('source contract declares the native comments task driver; execution is a separate native suite',async()=>{
  const driver=await readFile(new URL('../src-tauri/src/mcp_test_driver.rs',import.meta.url),'utf8');
  const runner=await readFile(new URL('../scripts/test-mcp-native.mjs',import.meta.url),'utf8');
  assert.ok(driver.includes('async fn comments_task_gate('),'actual native comments task scenario must exist');
  assert.ok(runner.includes("'comments-task'"),'isolated native runner must accept comments-task');
  const gate=driver.slice(driver.indexOf('async fn comments_task_gate('));
  for(const name of ['list_comments','read_comment','locate_comment','apply_edit_batch','reconcile_request'])assert.ok(gate.includes(`"${name}"`),`actual ${name} call must be exercised`);
  assert.ok(gate.includes('source_digest')&&gate.includes('mutation_id'),'native proof checks committed renderer receipt');
});
