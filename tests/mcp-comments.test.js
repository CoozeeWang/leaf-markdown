import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

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
  assert.match(main,/handleMcpCommentQuery/,'production renderer must serve comment queries');
  for(const name of ['list_comments','read_comment','locate_comment'])assert.ok(rust.includes(`"${name}"`),`${name} must be discoverable through the broker`);
  assert.match(rust,/"comment_query"/,'query must reach existing Tauri bridge');
});
