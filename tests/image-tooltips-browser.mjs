import assert from 'node:assert/strict';
import {webkit} from 'playwright';
import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
import {desktopImageFixture} from './fixtures/desktop-image.mjs';
const source='Intro\n\n![Picture](assets/picture.svg)\n\nEnd\n';
const targets=process.env.LEAF_IMAGE_TOOLTIP_ENGINE==='webkit' ? [[webkit,{headless:true}]] : [[chromium,launchOptions]];
for(const [engine,options] of targets) {
 const browser=await engine.launch(options);
 try {
  const page=await browser.newPage({viewport:{width:900,height:700}});
  await desktopImageFixture(page,source,{platform:'MacIntel'});
  await page.evaluate(()=>v.dispatch({selection:{anchor:0}}));
  const image=page.locator('.cm-editor img[alt="Picture"]');
  await page.waitForFunction(()=>document.querySelector('img[alt="Picture"]')?.dataset.loaded==='yes');
  const action=page.locator('.leaf-image-actions');
  const tip=page.locator('#tooltip');
  const look=()=>tip.evaluate(el=>{
   const s=getComputedStyle(el),r=el.getBoundingClientRect();
   return {font:s.fontSize,weight:s.fontWeight,color:s.color,background:s.backgroundColor,border:s.borderColor,shadow:s.boxShadow,inBounds:r.left>=0&&r.right<=innerWidth};
  });
  for(const theme of ['light','dark']) {
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   await page.setViewportSize({width:theme==='dark'?440:900,height:700});
   await image.evaluate((el,theme)=>{el.style.width=theme==='light'?'320px':'120px';el.style.height=theme==='light'?'200px':'80px';},theme);
   await image.hover();
   await page.waitForFunction(()=>!document.querySelector('#tooltip').hidden&&document.querySelector('#tooltip').textContent.includes('拖动图片'));
   assert.equal(await image.evaluate(el=>el.closest('[title]')),null,'image instructions must not also trigger a native tooltip');
   assert.equal((await tip.textContent()).replace(/\s/g,''),'按住⌘拖动图片');
   const imageBox=await image.boundingBox(),tipBox=await tip.boundingBox(),actionBox=await action.boundingBox();
   assert.ok(Math.abs(tipBox.y-actionBox.y)<1,'drag hint aligns with reveal button');
   assert.ok(Math.abs(tipBox.x+tipBox.width-(imageBox.x+imageBox.width-4))<1,'drag hint anchors to image right inset');
   assert.ok(tipBox.x>=actionBox.x+actionBox.width,'small image hint does not cover reveal control');
   await page.screenshot({path:artifactPath(`image-drag-hint-${engine.name()}-${theme}.png`)});
   const imageLook=await look();
   assert.equal(imageLook.font,'12px');assert.equal(imageLook.weight,'400');assert.equal(imageLook.inBounds,true);
   await action.hover();
   await page.waitForFunction(()=>document.querySelector('#tooltip').textContent==='在 Finder 中显示');
   assert.deepEqual(await look(),imageLook,'both explanations share one visual style');
   assert.equal(await page.locator('#tooltip:not([hidden])').count(),1);
   await page.screenshot({path:artifactPath(`image-tooltip-${engine.name()}-${theme}.png`)});
  }
  await page.mouse.move(0,0);
  await page.waitForFunction(()=>document.querySelector('#tooltip').hidden);
  await action.focus();
  await page.waitForFunction(()=>!document.querySelector('#tooltip').hidden);
  assert.equal(await tip.textContent(),'在 Finder 中显示');
  await page.locator('#commandsButton').hover();
  await page.waitForFunction(()=>document.querySelector('#tooltip').dataset.kind==='default');
  assert.equal(await tip.evaluate(el=>getComputedStyle(el).fontWeight),'500','image styling does not leak to unrelated controls');
  assert.equal(await page.evaluate(()=>v.state.doc.toString()),source);
  console.log(`PASS ${engine.name()}: shared image tooltip, light/dark, narrow, keyboard and unchanged source`);
 } finally {await browser.close();}
}
