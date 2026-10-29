import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {launchOptions,artifactPath} from './browser-runtime.mjs';
const source='# Root\n\nIntro\n\n## One\n\nA {>>synthetic note<<}\n\n### Same\n\n> [!note]\n> detail [safe](https://example.com)\n\n#### Detail\n\nD\n\n### Other\n\nO\n\n## Two\n\nB\n\n### Same\n\nC\n\n## Three\n\nT\n\n# End\n\nE\n\n';
for(const [name,engine] of Object.entries({chromium,webkit})) {
 const browser=await engine.launch(name==='chromium'?launchOptions:{headless:true});
 try {for(const locale of ['zh-CN','zh-TW','en-US']) {
 const page=await browser.newPage({locale,viewport:{width:1100,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.LEAF_TEST_BASE_URL||'http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.evaluate(async()=>{const r=await import('/tests/outline-reorder-runtime.js');window.v=r.EditorView.findFromDOM(document.querySelector('.cm-content'));window.u=()=>r.undo(v);window.redo=()=>r.redo(v);window.depth=()=>r.undoDepth(v.state);window.hs=async()=> (await import('/src/outline-sections.js')).parseOutline(v.state.doc.toString());});
 const load=async(text=source)=>{await page.evaluate(text=>v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:text.indexOf('A {')>=0?text.indexOf('A {'):0}}),text);await page.waitForFunction(()=>document.querySelectorAll('.outline-item').length>0);await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>v.requestMeasure({read:()=>null,write:()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))}));});};
 await load();await page.click('#outlineButton');
 const read=()=>page.evaluate(()=>v.state.doc.toString()),head=i=>page.locator('.outline-item').nth(i),row=i=>head(i).locator('..');
 const start=async(i,mod=true)=>{await head(i).scrollIntoViewIfNeeded();const r=await head(i).boundingBox(),g={x:r.x+Math.min(60,r.width/2),y:r.y+r.height/2,level:Number(await head(i).getAttribute('data-level'))};await page.mouse.move(g.x,g.y);if(mod)await page.keyboard.down('Meta');await page.mouse.down();await page.mouse.move(g.x+1,g.y-7,{steps:3});if(mod)await page.keyboard.up('Meta');return g;};
 const aim=async(g,before,level)=>{let r=before===null?await row(await head(0).count()+await page.locator('.outline-item').count()-2).boundingBox():await row(before).boundingBox();const list=await page.locator('#outlineList').boundingBox();if(r.y<list.y+3||r.y+r.height+8>list.y+list.height){await page.mouse.move(g.x+(level-g.level)*14,r.y<list.y+3?list.y+5:list.y+list.height-5);const i=before===null?(await page.locator('.outline-item').count())-1:before;await page.waitForFunction(i=>{const r=document.querySelectorAll('.outline-row')[i].getBoundingClientRect(),b=document.querySelector('#outlineList').getBoundingClientRect();return r.top>=b.top+3&&r.bottom+8<b.bottom;},i);r=await row(i).boundingBox();}const y=before===null?r.y+r.height+6:r.y+2;await page.mouse.move(g.x+(level-g.level)*14,y,{steps:7});};
 const drop=async(i,before,level)=>{const g=await start(i);await aim(g,before,level);assert.equal(await page.locator('.outline-drop-line').isVisible(),true);assert.equal(await page.locator('.outline-drop-line').getAttribute('data-level'),String(level));await page.mouse.up();return g;};
 assert.equal(await page.locator('.level-action,.row-actions,.row-menu').count(),0);await head(5).hover();await page.waitForFunction(()=>!document.querySelector('#tooltip').hidden);assert.equal(await head(5).getAttribute('title'),null);assert.equal(await page.locator('#tooltip svg[data-modifier=Command]').count(),1);
 const before=await page.evaluate(()=>depth());await drop(5,7,3);let h=await page.evaluate(()=>hs());assert.equal(h.find(x=>x.text==='Two').level,3);assert.equal(await page.evaluate(()=>v.state.doc.lineAt(v.state.selection.main.head).text),'### Two');assert.equal(h.filter(x=>x.text==='Same')[1].level,4);assert.equal(await page.evaluate(()=>depth()),before+1);assert((await read()).includes('> detail [safe](https://example.com)'));await page.evaluate(()=>u());assert.equal(await read(),source);await page.evaluate(()=>redo());assert.notEqual(await read(),source);await page.evaluate(()=>u());
 // Real reachable gaps before and after a complete parent subtree.
 await drop(2,1,2);h=await page.evaluate(()=>hs());assert.equal(h[1].text,'Same');assert.equal(h.find(x=>x.text==='Other').parent,h.find(x=>x.text==='One').from);await page.evaluate(()=>u());
 await drop(2,5,2);h=await page.evaluate(()=>hs());assert.equal(h.find(x=>x.text==='Other').parent,h.find(x=>x.text==='One').from);await page.evaluate(()=>u());
 await drop(5,4,5);h=await page.evaluate(()=>hs());assert.equal(h.filter(x=>x.text==='Same')[1].level,6);await page.evaluate(()=>u());
 await drop(1,null,1);assert((await read()).endsWith('O\n\n'));await page.evaluate(()=>u());assert.equal(await read(),source);
 let g=await start(5,false);await aim(g,1,2);await page.mouse.up();assert.equal(await read(),source);
 g=await start(2);await aim(g,5,2);await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await read(),source);
 g=await start(2);await aim(g,5,2);await page.mouse.move(600,300);await page.mouse.up();assert.equal(await read(),source);
 g=await start(1);await aim(g,2,3);assert.equal(await page.locator('.outline-drop-line').isVisible(),false);await page.mouse.up();assert.equal(await read(),source);
 // Collapse is editor state, mapped through moves and inverted with undo.
 await row(1).locator('.outline-disclosure').click();await drop(1,null,1);let movedOne=page.locator('.outline-item').filter({hasText:/^One$/}).locator('..');assert.equal(await movedOne.locator('.outline-disclosure').getAttribute('aria-expanded'),'false');await page.evaluate(()=>u());assert.equal(await row(1).locator('.outline-disclosure').getAttribute('aria-expanded'),'false');await row(1).locator('.outline-disclosure').click();
 g=await start(5);await aim(g,7,3);await page.evaluate(()=>v.dispatch({changes:{from:v.state.doc.length,insert:'x'},userEvent:'input.type'}));await page.mouse.up();assert.equal(await read(),source+'x');await page.evaluate(()=>u());
 await page.click('#readingToggle');await page.click('[data-mode="source"]');await drop(5,7,3);await page.evaluate(()=>u());
 await page.setViewportSize({width:900,height:480});await page.evaluate(()=>document.documentElement.dataset.theme='dark');g=await start(5);await aim(g,7,3);assert.equal(await page.locator('.outline-drop-line').isVisible(),true);await page.screenshot({path:artifactPath(`outline-depth-${name}-${locale}.png`)});await page.keyboard.press('Escape');await page.mouse.up();
 // Long synthetic document: real pointer edge scrolling reaches a terminal gap.
 if(locale==='zh-CN'){
  await page.setViewportSize({width:1100,height:800});
  const long=Array.from({length:180},(_,i)=>`# Repeated long synthetic heading ${i} ${'标题 '.repeat(8)}\n\nBody ${i}\n\n`).join('');await load(long);assert.equal(await page.locator('.outline-item').count(),180);
  g=await start(0);const box=await page.locator('#outlineList').boundingBox();await page.mouse.move(g.x,box.y+box.height-5);
  await page.waitForFunction(()=>{const list=document.querySelector('#outlineList');return list.scrollTop>150;});
  await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await read(),long);
  await page.locator('#outlineList').evaluate(e=>e.scrollTop=0);await load();
 }
 // Editor API guards include a same-text document replacement while dragging.
 const protectedResults=await page.evaluate(async()=>{
  const {createLeafEditor}=await import('/src/editor.js'),{parseOutline}=await import('/src/outline-sections.js'),{EditorState,StateEffect,Prec}=await import('/tests/outline-reorder-runtime.js');
  const parent=document.createElement('div');document.body.append(parent);const e=createLeafEditor({parent,doc:'# A\n\nA\n\n# B\n\nB\n'}),snap=e.view.state.doc,gen=e.mutationDocumentGeneration(),h=parseOutline(snap.toString());const attempt=()=>e.moveOutlineSection(snap,gen,h[0].from,null,2);
  const task={task_id:'outline-task',session_id:'outline-session',document_id:'outline-document',authorization_epoch:1,scope:{from:0,to:snap.length},revision:0,client:'claude-desktop'};
  e.beginAiTask(task);const locked=attempt();e.finishAiTask(task);e.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'拼'}));const ime=attempt();e.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'拼'}));
  e.setValue(snap.toString());const replaced=attempt();const newSnap=e.view.state.doc,newGen=e.mutationDocumentGeneration();e.view.dispatch({effects:StateEffect.appendConfig.of(Prec.highest(EditorState.readOnly.of(true)))});const readonly=e.moveOutlineSection(newSnap,newGen,h[0].from,null,2);e.destroy();parent.remove();return {locked,ime,replaced,readonly};
 });assert.deepEqual(protectedResults,{locked:false,ime:false,replaced:false,readonly:false});assert.deepEqual(errors,[]);
 console.log(`PASS ${name}/${locale}: real pointer depth/position, whole parent gaps, H6, EOF, cancel, stale, collapse undo, isolated history, source, guards, tooltip glyph, 900px dark`);await page.close();
 }}finally{await browser.close();}
}
