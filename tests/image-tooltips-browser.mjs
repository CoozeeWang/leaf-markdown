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
   assert.equal((await tip.textContent()).replace(/\s/g,''),'按住拖动图片');
   const imageBox=await image.boundingBox(),tipBox=await tip.boundingBox();
   assert.equal(await tip.locator('svg[data-modifier=Command]').count(),1);
   assert.ok(tipBox.x+tipBox.width<=imageBox.x || tipBox.x>=imageBox.x+imageBox.width,'operation hint stays beside the image');
   assert.ok(tipBox.y>=0&&tipBox.y+tipBox.height<=700,'hint stays in the viewport');
   await page.screenshot({path:artifactPath(`image-drag-hint-${engine.name()}-${theme}.png`)});
   const imageLook=await look();
   assert.equal(imageLook.font,'12px');assert.equal(imageLook.weight,'400');assert.equal(imageLook.inBounds,true);
   await action.hover();
   await page.waitForFunction(()=>document.querySelector('#tooltip').textContent==='在 Finder 中显示');
   assert.equal(await tip.getAttribute('data-kind'),'control');assert.equal((await look()).weight,'400');assert.notEqual((await look()).background,imageLook.background,'control and operation hints have distinct backgrounds');
   assert.equal(await page.locator('#tooltip:not([hidden])').count(),1);
   await page.screenshot({path:artifactPath(`image-tooltip-${engine.name()}-${theme}.png`)});
  }
  await page.mouse.move(0,0);
  await page.waitForFunction(()=>document.querySelector('#tooltip').hidden);
  await action.focus();
  await page.waitForFunction(()=>!document.querySelector('#tooltip').hidden);
  assert.equal(await tip.textContent(),'在 Finder 中显示');
  await page.locator('#commandsButton').hover();
  await page.waitForFunction(()=>document.querySelector('#tooltip').dataset.kind==='control');
  assert.equal(await tip.evaluate(el=>getComputedStyle(el).fontWeight),'400','control tooltip also uses normal weight');
  // Use a stable viewport for language changes; narrow scrolling is covered above.
  await page.setViewportSize({width:1100,height:900});
  // Existing images must update without switching view modes or changing Markdown.
  let revision=0;
  for(const mode of ['edit','reading']) {
   if(mode==='reading') {await page.click('#readingToggle');await page.click('[data-mode="reading"]');}
   const selector=mode==='edit'?'.cm-editor .leaf-image-actions':'.reading-document .leaf-image-actions';
   const existingAction=page.locator(selector);
   await existingAction.evaluate(el=>window.originalImageAction=el);
   for(const [language,label] of [['zh-Hant-TW','在 Finder 中顯示'],['en','Show in Finder'],['zh-Hans','在 Finder 中显示']]) {
    await page.mouse.move(0,0);
    await page.evaluate(({language,revision})=>emitNative('leaf-language-changed',{preference:language,language,revision}),{language,revision:++revision});
    await page.waitForFunction(({selector,label})=>document.querySelector(selector)?.getAttribute('aria-label')===label,{selector,label});
    assert.equal(await existingAction.getAttribute('data-tooltip'),label);
    if(mode==='reading') assert.equal(await existingAction.evaluate(el=>el===window.originalImageAction),true,'reading mode updates the existing image action');
    await page.keyboard.press('Tab'); // establish keyboard modality and leave the previous action
    await existingAction.focus();
    await page.waitForFunction(label=>!document.querySelector('#tooltip').hidden&&document.querySelector('#tooltip').textContent===label,label,{timeout:5000}).catch(async error=>{throw new Error(JSON.stringify({mode,language,tooltip:await tip.textContent(),hidden:await tip.getAttribute('hidden')}),{cause:error});});
   }
  }
  assert.equal(await page.evaluate(()=>v.state.doc.toString()),source);
  console.log(`PASS ${engine.name()}: shared image tooltip, light/dark, narrow, keyboard, live three-language image controls in edit/read and unchanged source`);
 } finally {await browser.close();}
}
