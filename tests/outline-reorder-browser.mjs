import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {launchOptions,artifactPath} from './browser-runtime.mjs';
const a='# Same\n\nAlpha {>>synthetic note<<}\n\n## Child\n\n> [!note]\n> detail\n\n',b='# Same\n\nBeta [link](https://example.com)\n\n',c='# Last\n\nGamma\n';
const source=a+b+c;
for(const [name,engine] of Object.entries({chromium,webkit})) {
 const browser=await engine.launch(name==='chromium'?launchOptions:{headless:true});
 try {for(const locale of ['zh-CN','en-US']) {
 const page=await browser.newPage({locale,viewport:{width:1100,height:800}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto((process.env.LEAF_TEST_BASE_URL || 'http://127.0.0.1:41732'));await page.click('#welcomeNewButton');
 await page.evaluate(async source=>{
  const {EditorView,undo,redo,undoDepth}=await import('/tests/outline-reorder-runtime.js');
  window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));
  window.undo=()=>undo(v);window.redo=()=>redo(v);window.depth=()=>undoDepth(v.state);
  v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source},selection:{anchor:source.indexOf('Alpha'),head:source.indexOf('Alpha')+5}});
 },source);
 await page.click('#outlineButton');
 const read=()=>page.evaluate(()=>v.state.doc.toString());
 const drag=async(from,target,side,{cancel=false,stale=false,preview=false}={})=>{
  return page.evaluate(({from,target,side,cancel,stale,preview})=>{
   const buttons=[...document.querySelectorAll('.outline-item')],dataTransfer=new DataTransfer();
   const start=buttons[from],end=buttons[target],box=end.getBoundingClientRect();
   const init={bubbles:true,cancelable:true,dataTransfer,clientX:box.left+20,clientY:side==='before'?box.top+2:box.bottom-2};
   const accepted=start.dispatchEvent(new DragEvent('dragstart',init));
   if(!accepted)return false;
   end.dispatchEvent(new DragEvent('dragover',init));
   const marked=!!document.querySelector('.outline-drop-before,.outline-drop-after');
   if(preview)return marked;
   if(cancel)window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
   if(stale)v.dispatch({changes:{from:v.state.doc.length,insert:'x'},userEvent:'input.type'});
   end.dispatchEvent(new DragEvent('drop',init));start.dispatchEvent(new DragEvent('dragend',init));return marked;
  },{from,target,side,cancel,stale,preview});
 };
 assert.ok(await drag(3,0,'after',{preview:true}));
 assert.equal(await page.locator('.outline-drop-after').evaluate(node=>({tag:node.tagName,height:getComputedStyle(node,'::after').height})).then(x=>`${x.tag}/${x.height}`),'LI/2px');
 await page.screenshot({path:artifactPath(`outline-drop-marker-${name}-${locale}.png`)});
 await page.keyboard.press('Escape');assert.equal(await read(),source);
 const before=await page.evaluate(()=>depth());
 assert.ok(await drag(0,2,'after'));
 assert.equal(await read(),b+a+c);
 assert.equal(await page.evaluate(()=>v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to)),'Alpha');
 assert.equal(await page.evaluate(()=>depth()),before+1);
 await page.evaluate(()=>undo());assert.equal(await read(),source);
 await page.evaluate(()=>redo());assert.equal(await read(),b+a+c);
 await page.evaluate(()=>undo());
 assert.equal(await drag(1,2,'after'),false,'cross-level rejected');assert.equal(await read(),source);
 assert.ok(await drag(0,3,'after',{cancel:true}));assert.equal(await read(),source);
 await page.locator('.outline-disclosure').first().click();
 assert.ok(await drag(0,3,'after'));assert.equal(await read(),b+c+a,'collapsed subtree moves whole');
 await page.evaluate(()=>undo());assert.equal(await read(),source);

 assert.ok(await drag(3,0,'before'));assert.equal(await read(),c+a+b);
 await page.evaluate(()=>{v.dispatch({changes:{from:v.state.doc.length,insert:'typed'},userEvent:'input.type'});undo();});
 assert.equal(await read(),c+a+b,'typing separate from move');await page.evaluate(()=>undo());assert.equal(await read(),source);
 await drag(0,3,'after',{stale:true});assert.equal(await read(),source+'x','stale drag never applies');await page.evaluate(()=>undo());
 // Native pointer drag exercises the browser's real drag initiation / delivery.
 const start=page.locator('.outline-item').nth(3),end=page.locator('.outline-item').nth(0);
 await start.dragTo(end,{targetPosition:{x:30,y:2}});
 assert.equal(await read(),c+a+b,`${name} real pointer move`);
 await page.screenshot({path:artifactPath(`outline-reorder-${name}-${locale}.png`)});
 await page.evaluate(()=>undo());
 await page.click('#readingToggle');await page.click('[data-mode="source"]');
 assert.ok(await drag(0,3,'after'));assert.equal(await read(),b+c+a);await page.evaluate(()=>undo());
 // Edge scrolling uses the outline scroll container; cancellation preserves source.
 const long=Array.from({length:100},(_,i)=>`# Section ${i}\n\nBody ${i}\n\n`).join('');
 await page.evaluate(text=>v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:0}}),long);
 await page.evaluate(()=>{
  const list=document.querySelector('#outlineList'),button=list.querySelector('.outline-item'),dt=new DataTransfer(),box=list.getBoundingClientRect();
  button.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt,clientY:box.top+15}));
  button.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt,clientY:box.bottom-2}));
 });
 await page.waitForFunction(()=>document.querySelector('#outlineList').scrollTop>0);
 await page.keyboard.press('Escape');assert.equal(await read(),long);
 await page.evaluate(text=>v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:0}}),source);
 await page.click('#readingToggle');await page.click('[data-mode="reading"]');
 assert.equal(await drag(0,3,'after'),false);assert.equal(await read(),source);
 // Exercise editor API guards without relying on an application-level test hook.
 const protectedResults=await page.evaluate(async()=>{
  const {createLeafEditor}=await import('/src/editor.js');
  const {parseOutline}=await import('/src/outline-sections.js');
  const parent=document.createElement('div');document.body.append(parent);
  const e=createLeafEditor({parent,doc:'# A\n\nA\n\n# B\n\nB\n'}),snap=e.view.state.doc,hs=parseOutline(snap.toString()),gen=e.mutationDocumentGeneration();
  const attempt=()=>e.moveSection(snap,gen,hs[0].from,hs[1].from,'after');
  const task={task_id:'outline-task',session_id:'outline-session',document_id:'outline-document',authorization_epoch:1,scope:{from:0,to:snap.length},revision:0,client:'claude-desktop'};
  e.beginAiTask(task);const locked=attempt();e.finishAiTask(task);
  e.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'拼'}));const ime=attempt();
  e.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'拼'}));
  e.setValue(snap.toString());const replaced=attempt();
  const nested='# P\n\n### A\n\na\n\n### B\n\nb\n\n# Q\n\n### C\n';e.setValue(nested);
  const nh=parseOutline(nested),ns=e.view.state.doc,ng=e.mutationDocumentGeneration();
  const crossParent=e.moveSection(ns,ng,nh[1].from,nh[4].from,'after');
  const sibling=e.moveSection(ns,ng,nh[1].from,nh[2].from,'after');
  e.destroy();parent.remove();return {locked,ime,replaced,crossParent,sibling};
 });
 assert.deepEqual(protectedResults,{locked:false,ime:false,replaced:false,crossParent:false,sibling:true});assert.deepEqual(errors,[]);
 console.log(`PASS ${name}/${locale}: exact subtree, duplicate titles, nested rejection, cancellation, collapsed, first/last, selection, isolated undo/redo, typing, stale snapshot, native pointer, source mode, edge scrolling, reading/AI/IME guards`);
 await page.close();
 }}finally{await browser.close();}
}
