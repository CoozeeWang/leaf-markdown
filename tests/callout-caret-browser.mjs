import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
for(const engine of [chromium,webkit]) {
 const browser=await engine.launch({headless:true});
 try {
  const page=await browser.newPage();await page.goto('http://127.0.0.1:41732/tests/native-callout-caret.html?browser');
  assert.equal((await page.evaluate(()=>runTest())).pass,true);
  await page.evaluate(()=>{e.focus();e.restoreValue('> [!note]\n> Body\n\n');});
  await page.locator('.leaf-callout-body .leaf-callout-preview').click();
  const body=page.locator('.leaf-callout-body textarea');
  await body.evaluate(n=>n.setSelectionRange(n.value.length,n.value.length));await body.press('Enter');
  assert.equal(await body.inputValue(),'Body\n\n');
  await page.keyboard.type('Next');assert.equal(await body.inputValue(),'Body\n\nNext');
  await page.waitForFunction(()=>document.activeElement.classList.contains('leaf-measured-caret'));
  assert.ok(await body.locator('..').locator('.leaf-callout-caret').evaluate(n=>n.getBoundingClientRect().height<39));
  await body.press('ControlOrMeta+z');assert.equal(await body.inputValue(),'Body\n\nNex');
  await body.press('ControlOrMeta+Shift+z');assert.equal(await body.inputValue(),'Body\n\nNext');
  await body.press('Shift+Enter');assert.equal(await body.inputValue(),'Body\n\nNext\\\n');
  const saved=await page.evaluate(()=>e.getValue());await body.blur();await page.locator('.leaf-callout-body .leaf-callout-preview').click();
  assert.equal(await page.evaluate(()=>e.getValue()),saved);
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await body.locator('..').locator('.leaf-callout-caret').evaluate(n=>getComputedStyle(n).animationName),'none');
  console.log(`${engine.name()}: caret geometry at three sizes, blank/nonblank/wrapped text, selection, synthetic IME, actual typing/Enter/undo, render/reload and cleanup passed`);
 } finally {await browser.close();}
}
