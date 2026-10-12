import assert from 'node:assert/strict';
import { webkit } from 'playwright';
import { chromium, launchOptions } from './browser-runtime.mjs';

for (const engine of ['chrome','webkit']) {
 const browser=await (engine==='webkit'?webkit.launch({headless:true}):chromium.launch(launchOptions));
 try {
  const page=await browser.newPage({locale:'zh-CN',viewport:{width:1100,height:800}});
  page.setDefaultTimeout(10000);
  await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
  await page.locator('.cm-content').fill('---\ntitle: Sample\n---\n\n# Sample\n\nUnchanged text.');
  const active=()=>page.evaluate(()=>document.activeElement.id);
  for(const mode of ['edit','reading','source']) {
   await page.click('#readingToggle');await page.click(`[data-mode="${mode}"]`);
   await page.click('#displayButton');
   // Hold the mouse down across a frame: macOS may blur checkboxes before click.
   for (const input of await page.locator('#displayPopover input:not(:disabled)').all()) {
    for (const target of [input, input.locator('..').locator('span').first()]) {
     const before = await input.isChecked();
     await target.hover(); await page.mouse.down(); await page.waitForTimeout(100); await page.mouse.up();
     assert.equal(await input.isChecked(),!before,'Mouse toggles the switch');
     assert.ok(await page.locator('#displayPopover').isVisible(),'Switchboard stays open');
    }
   }
   await page.locator('#displayPopover input:not(:disabled)').first().focus();
   const first=await active();
   await page.keyboard.press('Tab');await page.waitForTimeout(50);
   if(engine==='chrome') {
    assert.ok(await page.locator('#displayPopover').isVisible(),`${mode}: Tab stays within switches`);
    assert.notEqual(await active(),first);
    await page.keyboard.press('Shift+Tab');assert.equal(await active(),first);
   }
   // Platform keyboard settings may omit checkboxes from Tab, but focus moving
   // among eligible controls must never dismiss the panel.
   if(await page.locator('#displayPopover').isHidden())await page.click('#displayButton');
   const eligible=page.locator('#displayPopover input:not(:disabled)');
   await eligible.last().focus();await page.waitForTimeout(50);
   assert.ok(await page.locator('#displayPopover').isVisible());
   const before=await eligible.last().isChecked();await page.keyboard.press('Space');
   assert.equal(await eligible.last().isChecked(),!before);
   await page.keyboard.press('Space');
   await page.keyboard.press('Escape');assert.equal(await active(),'displayButton');
   await page.click('#displayButton');await eligible.first().focus();await page.keyboard.press('Shift+Tab');
   await page.waitForFunction(()=>document.querySelector('#displayPopover').hidden);
   assert.equal(await page.locator('#displayButton').getAttribute('aria-expanded'),'false');
  }
  await page.click('#readingToggle');await page.click('[data-mode="edit"]');
  await page.click('#appearanceButton');await page.click('#settingsTab-appearance');
  await page.keyboard.press('Tab');assert.equal(await active(),'themeSelect');
  await page.waitForTimeout(50);assert.ok(await page.locator('#appearancePopover').isVisible());
  await page.locator('#contentWidthInput').focus();await page.keyboard.press('Tab');
  await page.waitForFunction(()=>document.querySelector('#appearancePopover').hidden);
  assert.equal(await page.locator('#appearanceButton').getAttribute('aria-expanded'),'false');
  await page.click('#appearanceButton');await page.keyboard.press('Escape');assert.equal(await active(),'appearanceButton');
  // Closing via the trigger must not reopen the panel after deferred focusout.
  await page.click('#appearanceButton');await page.click('#appearanceButton');await page.waitForTimeout(50);
  assert.ok(await page.locator('#appearancePopover').isHidden());
  for(const mode of ['edit','reading','source']) {
   await page.click('#readingToggle');await page.click(`[data-mode="${mode}"]`);
   await page.click('#focusButton');
   assert.ok(await page.locator('.shell').evaluate(e=>e.classList.contains('focus-mode')));
   assert.ok(await page.evaluate(()=>document.activeElement===document.querySelector('#readingPane') || document.activeElement.matches('.cm-content')));
   assert.ok(await page.locator('.topbar,.format-toolbar,.statusbar').evaluateAll(es=>es.every(e=>e.inert)));
   await page.locator('#openButton').focus();
   assert.notEqual(await active(),'openButton','Hidden toolbar cannot take focus');
   // Shift+Tab avoids CodeMirror interpreting Tab as document indentation.
   for(let i=0;i<8;i++) {
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(()=>!!document.activeElement.closest('[inert]')),false);
   }
   await page.keyboard.press('Escape');
   assert.ok(await page.locator('.topbar,.format-toolbar,.statusbar').evaluateAll(es=>es.every(e=>!e.inert)));
   await page.locator('#openButton').focus();assert.equal(await active(),'openButton');
  }
  console.log(`PASS ${engine}: panel Tab/Shift+Tab, switches, Escape/trigger close, focus exits and inert focus mode in three views`);
 }finally{await browser.close();}
}
