import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {launchOptions,artifactPath} from './browser-runtime.mjs';
import {desktopImageFixture} from './fixtures/desktop-image.mjs';
const source='# Root\n\nIntro\n\n## A\n\nFirst\n\n## B\n\nSecond\n\n# End\n\nTail\n';
for(const [name,engine] of Object.entries({chromium,webkit})){
 const browser=await engine.launch(name==='chromium'?launchOptions:{headless:true});
 try {for(const platform of ['MacIntel','Win32']){
  const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await desktopImageFixture(page,source,{platform});await page.click('#outlineButton');
  const item=text=>page.locator('.outline-item').filter({hasText:new RegExp(`^${text}$`)}),b=item('B');await b.hover();
  await page.waitForFunction(()=>!document.querySelector('#tooltip').hidden);
  assert.equal(await b.getAttribute('title'),null);assert.equal(await b.getAttribute('data-tooltip'),platform==='MacIntel'?'按住 ⌘ 调整位置':'按住 Ctrl 调整位置');
  assert.equal(await page.locator('#tooltip svg[data-modifier=Command]').count(),platform==='MacIntel'?1:0);
  if(platform==='Win32')assert.match(await page.locator('#tooltip').textContent(),/Ctrl/);
  if(name==='chromium'&&platform==='MacIntel')await page.screenshot({path:artifactPath('outline-operation-tooltip.png')});
  const r=await b.boundingBox(),end=await item('End').locator('..').boundingBox(),mod=platform==='MacIntel'?'Meta':'Control';
  await page.keyboard.down(mod);assert.equal(await page.locator('#tooltip').isVisible(),false);
  await page.mouse.move(r.x+55,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+55,r.y-7,{steps:3});await page.keyboard.up(mod);
  await page.mouse.move(r.x+41,end.y+2,{steps:8});await page.waitForFunction(()=>!document.querySelector('.outline-drop-line').hidden);
  assert.equal(await page.locator('.outline-drop-line').getAttribute('data-level'),'1');assert.equal(await page.locator('#tooltip').isVisible(),false);
  await page.waitForTimeout(950);assert.equal(await page.locator('#tooltip').isVisible(),false,'no new hint while hovering another row during drag');
  await page.mouse.up();assert.match(await page.evaluate(()=>v.state.doc.toString()),/\n# B\n\nSecond\n\n# End/);
  await page.click('#undoButton');assert.equal(await page.evaluate(()=>v.state.doc.toString()),source);
  await page.mouse.move(600,50);await page.waitForTimeout(150);await item('B').hover();await page.waitForFunction(()=>!document.querySelector('#tooltip').hidden);
  assert.deepEqual(errors,[]);console.log(`PASS ${name}/${platform}: actual modifier-specific pointer drag, release modifier continues, tooltip hides, depth/source change and undo; hover re-arms`);await page.close();
 }}finally{await browser.close();}
}
