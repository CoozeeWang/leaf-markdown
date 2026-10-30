import {webkit} from 'playwright';
import assert from 'node:assert/strict';
import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
const browser=process.env.LEAF_TOOLTIP_ENGINE==='webkit'?await webkit.launch({headless:true}):await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.locator('#appearanceButton').hover();await page.locator('#tooltip').waitFor({state:'visible'});await page.screenshot({path:artifactPath('control-tooltip.png')});await page.mouse.move(0,0);await page.waitForTimeout(150);
 await page.evaluate(()=>{
  const wrap=document.createElement('div');wrap.id='tip-fixtures';wrap.style='position:fixed;left:400px;top:300px;z-index:500;display:flex;gap:10px';
  wrap.innerHTML='<button id="tip-first" data-tooltip="保存 ⌘S" aria-describedby="existing-description">First</button><button id="tip-second" data-tooltip="第二个控件">Second</button><button id="tip-operation" data-tooltip-kind="operation" data-tooltip="按住 ⌘ 调整位置">Operation</button><span id="existing-description" hidden>Existing description</span>';
  document.body.append(wrap);
  new MutationObserver(()=>{if(!document.querySelector('#tooltip').hidden)window.tipShownAt=performance.now();}).observe(document.querySelector('#tooltip'),{attributes:true,attributeFilter:['hidden']});
  wrap.addEventListener('pointerover',()=>window.tipEnteredAt=performance.now());
 });
 const tip=page.locator('#tooltip'),first=page.locator('#tip-first'),second=page.locator('#tip-second'),op=page.locator('#tip-operation');
 const shown=()=>page.waitForFunction(()=>!document.querySelector('#tooltip').hidden);
 const hidden=()=>page.waitForFunction(()=>document.querySelector('#tooltip').hidden);
 await first.hover();await page.waitForTimeout(420);assert.equal(await tip.isVisible(),false);await shown();
 assert.ok(await page.evaluate(()=>tipShownAt-tipEnteredAt>=560),'control hover waits 600ms');
 assert.equal(await tip.getAttribute('data-kind'),'control');
 assert.equal(await first.getAttribute('aria-describedby'),'existing-description tooltip');
 assert.equal(await tip.locator('svg[data-modifier=Command]').count(),1);
 await second.hover();assert.equal(await tip.isVisible(),false,'adjacent control starts its own delay');await shown();assert.equal(await tip.textContent(),'第二个控件');
 assert.equal(await first.getAttribute('aria-describedby'),'existing-description','original description preserved');
 await op.hover();await page.waitForTimeout(650);assert.equal(await tip.isVisible(),false);await shown();
 assert.ok(await page.evaluate(()=>tipShownAt-tipEnteredAt>=760),'operation hover waits 800ms');
 assert.equal(await tip.getAttribute('data-kind'),'operation');assert.equal(await tip.evaluate(e=>getComputedStyle(e).fontWeight),'400');
 const anchor=await op.boundingBox(),position=await tip.boundingBox();await page.mouse.move(anchor.x+2,anchor.y+2);assert.deepEqual(await tip.boundingBox(),position,'hint does not follow pointer');assert.ok(Math.abs(position.x-anchor.x-anchor.width-8)<1);
 await page.mouse.move(anchor.x+anchor.width+4,anchor.y+anchor.height/2);
 await page.mouse.move(position.x+position.width/2,position.y+position.height/2);await page.waitForTimeout(200);
 assert.equal(await tip.isVisible(),true,'tooltip can be entered across its gap');
 await page.waitForTimeout(5200);assert.equal(await tip.isVisible(),true,'no fixed reading timeout');
 await page.mouse.move(0,0);await hidden();
 for(const key of ['Meta','Control','Shift','Alt','Escape']) {
  await op.hover();await shown();await page.keyboard.down(key);await hidden();await page.keyboard.up(key);
  await page.waitForTimeout(900);assert.equal(await tip.isVisible(),false,`${key} suppresses the current hover`);
  await page.mouse.move(0,0);await page.waitForTimeout(150);
 }
 await op.hover();await shown();await op.click();await hidden();await page.waitForTimeout(900);assert.equal(await tip.isVisible(),false,'click suppresses hover');
 await page.mouse.move(0,0);await page.waitForTimeout(150);await op.hover();await shown();
 await op.dispatchEvent('dragstart');await hidden();await page.waitForTimeout(900);assert.equal(await tip.isVisible(),false,'drag hides and suppresses');await op.dispatchEvent('dragend');
 await page.mouse.move(0,0);await page.waitForTimeout(150);await op.hover();await shown();
 await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await hidden();await page.waitForTimeout(900);assert.equal(await tip.isVisible(),false,'window blur suppresses');
 // Real keyboard traversal: a click establishes mouse modality, Tab switches it.
 await first.click();await first.focus();await page.mouse.move(0,0);await page.keyboard.press(process.env.LEAF_TOOLTIP_ENGINE==='webkit'?'Alt+Tab':'Tab');
 assert.equal(await second.evaluate(e=>document.activeElement===e),true);assert.equal(await tip.isVisible(),true);assert.equal(await tip.textContent(),'第二个控件');
 await page.keyboard.press('Escape');await hidden();
 for(const theme of ['light','dark']) for(const zoom of [1,1.5,2]) {
  await page.evaluate(({theme,zoom})=>{document.documentElement.dataset.theme=theme;document.documentElement.style.zoom=zoom;const w=document.querySelector('#tip-fixtures');w.style.left='auto';w.style.right='10px';w.style.top='auto';w.style.bottom='10px';document.querySelector('#tip-operation').dataset.tooltip='按住 ⌘ 调整位置。'+ '这是一段用于核对窄窗边缘换行与持续阅读的中文操作说明。'.repeat(5);},{theme,zoom});
  await page.setViewportSize({width:520,height:500});await page.mouse.move(0,0);await page.waitForTimeout(150);await op.hover();await shown();
  const r=await tip.boundingBox(),a=await op.boundingBox();assert.ok(r.x>=7&&r.y>=7&&r.x+r.width<=521&&r.y+r.height<=501,JSON.stringify({theme,zoom,r}));assert.ok(r.x<a.x,'right edge flips left');
  assert.equal(await tip.evaluate(e=>getComputedStyle(e).fontSize),'12px');
  await page.screenshot({path:artifactPath(`tooltip-${theme}-zoom-${zoom}.png`)});
 }
 await page.evaluate(()=>document.documentElement.style.zoom='1');await page.mouse.move(0,0);await page.waitForTimeout(150);await op.hover();await shown();await op.evaluate(e=>e.remove());await hidden();
 assert.equal(await page.locator('[title]').count(),0,'no duplicate native application titles');assert.deepEqual(errors,[]);
 console.log('PASS tooltips: measured delays, keyboard immediate, SVG, ARIA, adjacent targets, readable bridge/no timeout, all suppressions, repeated cycles, themes, zoom/edges/long Chinese, removed trigger');
}finally{await browser.close();}
