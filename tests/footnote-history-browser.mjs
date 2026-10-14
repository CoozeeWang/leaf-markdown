import assert from 'node:assert/strict';
import {webkit} from 'playwright';
import {chromium,launchOptions} from './browser-runtime.mjs';
for(const engine of ['chrome','webkit']) {
 const browser=await(engine==='webkit'?webkit.launch({headless:true}):chromium.launch(launchOptions));
 try {
  for(const platform of engine==='chrome'?['MacIntel','Win32']:['MacIntel']) {
   const page=await browser.newPage({viewport:{width:1200,height:950}}),errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(platform=>{Object.defineProperty(navigator,'platform',{get:()=>platform});Object.defineProperty(navigator,'userAgentData',{get:()=>undefined});},platform);
   await page.goto('http://127.0.0.1:41732/tests/native-footnote-history.html');
   await page.waitForFunction(()=>window.fixtureReady);
   const text=()=>page.evaluate(()=>doc());
   const popup=page.locator('.footnote-box textarea');
   const chord=platform==='MacIntel'?'Meta':'Control';
   const insert=async(source,at=source.length)=>{
    await page.evaluate(({source,at})=>setDoc(source,at),{source,at});
    await page.click('[data-format=footnote]');
    await page.waitForFunction(()=>document.activeElement?.matches('.footnote-box textarea'));
    return text();
   };
   const original='Example body.';
   let inserted=await insert(original);
   await page.keyboard.press(chord+'+z');
   assert.equal(await text(),original,'popup undo removes both marker and definition');
   assert.equal(await popup.count(),0,'undo closes removed note');
   assert.equal(await page.evaluate(()=>document.activeElement===v.contentDOM),true);
   await page.keyboard.press(chord+'+Shift+Z');assert.equal(await text(),inserted,'redo after focus return restores insertion');
   if(platform==='Win32') {
    await page.keyboard.press('Control+z');await page.keyboard.press('Control+y');assert.equal(await text(),inserted,'Windows Ctrl+Y redoes insertion');
   }
   inserted=await insert(original);
   await page.keyboard.type('Note body');
   const written=await text();
   assert.ok(written.includes('[^1]: Note body'));
   await page.keyboard.press(chord+'+z');assert.equal(await text(),inserted);
   assert.equal(await popup.inputValue(),'','undo updates floating buffer');
   assert.equal(await page.evaluate(()=>document.activeElement.matches('.footnote-box textarea')),true);
   await page.keyboard.press(platform==='Win32'?'Control+y':'Meta+Shift+Z');
   assert.equal(await text(),written);assert.equal(await popup.inputValue(),'Note body');
   await page.keyboard.press(chord+'+z');await page.keyboard.type('Replacement');
   assert.ok((await text()).includes('[^1]: Replacement'),'typing after undo must not resurrect stale buffer');
   const replacement=await text();
   await page.keyboard.press(chord+'+Shift+Z');assert.equal(await text(),replacement,'new input clears redo');
   // Native macOS accelerators arrive through leaf-menu instead of DOM keydown.
   await page.evaluate(()=>menuHistory('undo'));assert.equal(await text(),inserted);assert.equal(await popup.inputValue(),'');
   await page.evaluate(()=>menuHistory('redo'));assert.equal(await text(),replacement);assert.equal(await popup.inputValue(),'Replacement');
   await page.evaluate(()=>menuHistory('undo'));await page.evaluate(()=>menuHistory('undo'));
   assert.equal(await text(),original);assert.equal(await popup.count(),0);
   await page.evaluate(()=>menuHistory('redo'));assert.equal(await text(),inserted);
   // Undoing a new numeric label must not attach its popup to an older note
   // that regains that same number during renumbering.
   const existing='A[^1] B[^2]\n\n[^1]: First\n[^2]: Second';
   const renumbered=await insert(existing,1);
   await page.evaluate(()=>menuHistory('undo'));assert.equal(await text(),existing);assert.equal(await popup.count(),0);
   await page.evaluate(()=>menuHistory('redo'));assert.equal(await text(),renumbered);
   const callout='> [!NOTE]\n> Example';
   await page.evaluate(source=>setDoc(source,0),callout);
   await page.locator('.leaf-callout-body .leaf-callout-preview').click();
   const field=page.locator('.leaf-callout-body textarea');
   await field.focus();await field.press('End');
   await page.click('[data-format=footnote]');await page.waitForFunction(()=>document.activeElement?.matches('.footnote-box textarea'));
   await page.keyboard.press(chord+'+z');assert.equal(await text(),callout,'callout note uses document undo too');
   assert.equal(await popup.count(),0);
   assert.deepEqual(errors,[]);
   console.log(`PASS ${engine} ${platform}: popup undo/redo, menu routing, buffer sync, focus and renumbering`);
   await page.close();
  }
 }finally{await browser.close();}
}
