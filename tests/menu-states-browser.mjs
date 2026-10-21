import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage();await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 for(const theme of ['light','dark']){
  await page.click('#appearanceButton');await page.click('#settingsTab-appearance');await page.selectOption('#themeSelect',theme);await page.keyboard.press('Escape');
  await page.click('#calloutButton');const rows=page.locator('#calloutPopover .callout-types button');await rows.nth(2).hover();
  assert.ok(await rows.nth(2).evaluate(e=>e===document.activeElement));
  await page.keyboard.press('ArrowUp');assert.ok(await rows.nth(1).evaluate(e=>e===document.activeElement));
  await page.waitForTimeout(200);
  assert.equal(await rows.nth(2).evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
  await page.screenshot({path:artifactPath(`menu-candidate-${theme}.png`)});
  await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'calloutButton');
  await page.click('#readingToggle');await page.locator('[data-mode=reading]').hover();
  const current=page.locator('[data-mode=edit]');assert.equal(await current.getAttribute('aria-checked'),'true');
  assert.equal(await current.evaluate(e=>getComputedStyle(e,'::after').content),'"✓"');
  await page.waitForTimeout(200);assert.equal(await current.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
  await page.screenshot({path:artifactPath(`menu-current-${theme}.png`)});
  await page.keyboard.press('Escape');await page.click('#headingButton');
  const selected=page.locator('#headingPopover [aria-pressed=true]');assert.equal(await selected.count(),1);
  for (const level of [1,2,3,4,5,6,0]) {
   await page.click(`#headingPopover [data-format=heading${level}]`);
   await page.click('#headingButton');
   assert.equal(await selected.count(),1);
   assert.equal(await selected.getAttribute('data-format'),`heading${level}`);
   const marker=await selected.evaluate(e=>{
    const s=getComputedStyle(e,'::after');
    return {content:s.content,width:s.width,height:s.height,bottom:s.bottom,
     center:parseFloat(s.left),buttonWidth:e.clientWidth};
   });
   assert.equal(marker.content,'""');assert.equal(marker.width,'16px');assert.equal(marker.height,'2px');
   assert.equal(marker.bottom,'4px');assert.ok(Math.abs(marker.center-marker.buttonWidth/2)<1);
   await page.keyboard.press('ArrowRight');
   assert.equal(await selected.getAttribute('data-format'),`heading${level}`,'moving focus preserves the current level');
  }
  await page.keyboard.press('ArrowRight');await page.waitForTimeout(200);await page.screenshot({path:artifactPath(`menu-heading-${theme}.png`)});
  await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'headingButton');
 }
 console.log('PASS pointer/keyboard share one candidate; persistent mode check and centered heading underline remain distinct');
}finally{await browser.close();}
