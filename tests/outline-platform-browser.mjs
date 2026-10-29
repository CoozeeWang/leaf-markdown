import assert from 'node:assert/strict';
import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
const source='# Root\n\n## A\n\nAlpha\n\n## B\n\nBeta\n\n# End\n';
const browser=await chromium.launch(launchOptions);
try{for(const platform of ['MacIntel','Win32']){
 const page=await browser.newPage({viewport:{width:900,height:480}});
 await page.addInitScript(platform=>{Object.defineProperty(navigator,'platform',{get:()=>platform});Object.defineProperty(navigator,'userAgentData',{get:()=>({platform:platform==='Win32'?'Windows':'macOS'})});},platform);
 await page.goto(process.env.LEAF_TEST_BASE_URL||'http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.evaluate(async text=>{const {EditorView}=await import('/tests/outline-reorder-runtime.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:0}});},source);
 await page.click('#outlineButton');const h=page.locator('.outline-item').nth(2);await h.hover();await page.waitForFunction(()=>!document.querySelector('#tooltip').hidden);
 if(platform==='MacIntel'){assert.equal(await page.locator('#tooltip [role=img]').getAttribute('aria-label'),'Command');assert.equal(await page.locator('#tooltip').textContent(),'按住  调整位置');}
 else assert.equal(await page.locator('#tooltip').innerText(),'按住 Ctrl 调整位置');
 // These are platform-branch simulations. macOS reserves physical Ctrl-click.
 const r=await h.boundingBox();await page.mouse.move(r.x+60,r.y+15);await page.mouse.down();
 const rejected=await h.evaluate((e,platform)=>{const r=e.getBoundingClientRect();e.dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,button:0,bubbles:true,clientX:r.x+60,clientY:r.y+15,...(platform==='Win32'?{metaKey:true}:{ctrlKey:true})}));return true;},platform);
 await page.mouse.move(r.x+61,r.y+6);assert.equal(await page.locator('.outline-drop-line').isVisible(),false);await page.mouse.up();assert(rejected);
 await page.mouse.move(r.x+60,r.y+15);await page.mouse.down();await h.evaluate((e,platform)=>{const r=e.getBoundingClientRect();e.dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,button:0,bubbles:true,clientX:r.x+60,clientY:r.y+15,...(platform==='Win32'?{ctrlKey:true}:{metaKey:true})}));},platform);
 const end=await page.locator('.outline-row').last().boundingBox();await page.mouse.move(r.x+74,end.y+2,{steps:8});assert.equal(await page.locator('.outline-drop-line').getAttribute('data-level'),'3');await page.screenshot({path:artifactPath(`outline-platform-${platform}.png`)});await page.mouse.up();assert.equal(await page.evaluate(()=>v.state.doc.toString()),source.replace('## B','### B'));
 await page.click('#undoButton');assert.equal(await page.evaluate(()=>v.state.doc.toString()),source);console.log(`PASS ${platform}: exact platform hint, standalone modifier glyph, wrong-key rejection, modifier-injected pointer move and undo (platform simulation)`);await page.close();
}}finally{await browser.close();}
