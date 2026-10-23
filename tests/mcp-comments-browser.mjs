import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium,launchOptions} from './browser-runtime.mjs';

const browser=await chromium.launch(launchOptions);
try {
 await test('live comment bridge shares one task undo, readable locked panel and independent editor',async()=>{
  const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
   window.isTauri=true;let id=0;const callbacks={},handlers={},replies={};
   const content='---\ntitle: "Old"\n---\n\n{==**重复😀é**==}{>>one<<}{==重复😀é==}{>>two<<} end{>>point<<}.\n\n%%hidden\n\nliteral%%\n\nPlain😀é end.';
   window.commentBridge=(operation,args={})=>new Promise(resolve=>{const call_id=`call-${++id}`;replies[call_id]=resolve;handlers['leaf-mcp-editor']({payload:{window_label:'document-test',call_id,operation,args}});});
   window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'document-test'},currentWebview:{label:'document-test'}},transformCallback:fn=>{callbacks[++id]=fn;return id;},invoke:async(command,args={})=>{
     if(command==='update_participant_status')return {window_nonce:1,prepare_id:null,phase:null,identity:null,frozen:false,manual_driver:false};
    if(command==='plugin:event|listen'){handlers[args.event]=callbacks[args.handler];return ++id;}
    if(command==='initial_path')return '/samples/comments.md';
    if(command==='observe_document')return {path:'/samples/comments.md',content};
    if(command==='read_document')return content;
    if(command==='language_get')return {preference:'zh-Hans',language:'zh-Hans',revision:0};
    if(command==='mcp_register')return {document_id:'doc-comments',session_id:'session-comments',authorization_epoch:2,mutation_generation:0};
    if(command==='mcp_renderer_reply'){replies[args.callId]?.(args.reply);return null;}
    if(['recent_list','recovery_list'].includes(command))return [];
    if(command==='recovery_retention')return 30;
    return null;
   }};
  });
  await page.goto(process.env.LEAF_TEST_BASE_URL||'http://127.0.0.1:41732');
  await page.waitForFunction(()=>typeof window.commentBridge==='function'&&document.querySelector('#editor .cm-content'));
  await page.waitForFunction(()=>document.querySelector('#editor .cm-content')?.getAttribute('contenteditable')==='true'&&document.querySelector('.shell')?.style.pointerEvents==='');
  const bind={document_id:'doc-comments',session_id:'session-comments',authorization_epoch:2};
  const call=(operation,args)=>page.evaluate(({operation,args})=>commentBridge(operation,args),{operation,args});
  const original=(await call('snapshot',{})).result;
  assert.equal((await call('begin',{...bind,task_id:'unauthorized',revision:original.revision,scope:{from:0,to:original.content.length}})).error,'not_authorized');
  await call('binding',{...bind,revision:original.revision,mutation_generation:0});
  const list=(await call('comment_query',{...bind,query:'list_comments',revision:original.revision,scope:{from:0,to:original.content.length}})).result;
  assert.equal(list.comments.length,4);
  const task={...bind,task_id:'task-comments',revision:original.revision,scope:{from:0,to:original.content.length}};
  const begun=await call('begin',task);assert.ok(begun.result,JSON.stringify(begun));
  await page.click('#commentsButton');
  assert.equal(await page.locator('.comment-card').count(),4);
  assert.equal(await page.locator('#commentInsert').isDisabled(),true);
  assert.equal(await page.locator('.comment-delete').first().isDisabled(),true);
  for(const quote of await page.locator('.comment-quote').all()){assert.equal(await quote.isEnabled(),true);await quote.click();}
  await page.locator('.comment-body').first().dblclick();assert.equal(await page.locator('#commentsList textarea').count(),0);
  await page.locator('.comment-body').first().press('Enter');
  await page.evaluate(()=>{document.querySelector('#commentInsert').dispatchEvent(new MouseEvent('click',{bubbles:true}));document.querySelector('.comment-delete').dispatchEvent(new MouseEvent('click',{bubbles:true}));});
  await page.keyboard.press('Alt+Meta+a');
  await page.evaluate(async()=>{
   const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
   const {createLeafEditor}=await import('/src/editor.js');
   const view=EditorView.findFromDOM(document.querySelector('#editor .cm-content'));window.commentView=view;
   view.dispatch({changes:{from:view.state.doc.length,insert:'forbidden'},filter:false});
   const parent=document.createElement('div');document.body.append(parent);window.otherCommentEditor=createLeafEditor({parent,doc:'Other document'});
   otherCommentEditor.view.dispatch({changes:{from:0,insert:'Editable '}});
  });
  assert.equal((await call('snapshot',{})).result.content,original.content);
  assert.equal(await page.evaluate(()=>otherCommentEditor.mcpSnapshot().content),'Editable Other document');
  const note=list.comments[0],batch={...bind,task_id:task.task_id,mutation_id:'mutation-comments-1',request_id:'request-comments-1',request_digest:'digest-comments-1',revision:original.revision,operations:[{kind:'comment',action:'delete',id:note.id,source_fingerprint:note.source_fingerprint,expected:note.source},{kind:'property',action:'set',key:'title',expected:'"Old"',value:'New'}]};
  const first=await call('apply',batch);assert.equal(first.result.changed,true);assert.deepEqual(await call('apply',batch),first);
  const current=(await call('snapshot',{})).result,point=current.content.length;
  const second=await call('apply',{...batch,mutation_id:'mutation-comments-2',request_id:'request-comments-2',request_digest:'digest-comments-2',revision:current.revision,operations:[{kind:'comment',action:'add',from:point,to:point,expected:'',text:'last😀é'}]});assert.equal(second.result.changed,true);
  assert.equal(await page.locator('.comment-card').count(),4);assert.equal(await page.locator('.comment-delete').last().isDisabled(),true);
  const final=(await call('snapshot',{})).result;
  await call('finish',task);
  await page.click('#undoButton');assert.equal((await call('snapshot',{})).result.content,original.content);
  await page.click('#redoButton');assert.equal((await call('snapshot',{})).result.content,final.content);
  assert.equal(await page.locator('.comment-quote').first().isEnabled(),true);
  assert.deepEqual(errors,[]);await page.close();
 });
} finally {await browser.close();}
