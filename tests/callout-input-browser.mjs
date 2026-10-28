import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';

for(const engine of [chromium,webkit]) {
 const browser=await engine.launch({headless:true});
 try {
  const page=await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.goto('http://127.0.0.1:41732');
  await page.locator('#welcomeNewButton').click();
  await page.evaluate(async()=>{
   const {createLeafEditor}=await import('/src/editor.js');
   const parent=document.createElement('div');parent.id='callout-fixture';parent.style.cssText='position:fixed;inset:80px;z-index:10000;overflow:auto;background:white';document.body.append(parent);
   window.e=createLeafEditor({parent,doc:''});
  });
  const load=async value=>{await page.evaluate(value=>{e.focus();e.restoreValue(value);},value);};
  const source=()=>page.evaluate(()=>e.getValue());
  const title=page.locator('#callout-fixture .leaf-callout-title textarea');
  const body=page.locator('#callout-fixture .leaf-callout-body textarea');
  for(const language of ['zh-Hans','zh-Hant-TW','en']) {
   await page.evaluate(async language=>{await (await import('/src/i18n.js')).setLanguagePreference(language);},language);
   const types=await page.evaluate(async()=>Object.keys((await import('/src/callout.js')).labels));
   for(const type of types) {
    await load('');await page.evaluate(type=>e.format('callout-'+type),type);
    await title.waitFor({state:'visible'});
    await page.waitForFunction(()=>document.activeElement===document.querySelector('#callout-fixture .leaf-callout-title textarea'));
    assert.equal(await body.inputValue(),'');
    assert.ok(await body.getAttribute('placeholder'));
    assert.equal((await source()).trim(),`> [!${type}]\n>`);
    const saved=await source();await load(saved);
    assert.equal(await body.inputValue(),'');
   }
  }
  await load('> [!note] Title\n> Body\n\n');
  await page.locator('#callout-fixture .leaf-callout-title .leaf-callout-preview').click({position:{x:8,y:8}});
  await title.evaluate(n=>n.setSelectionRange(n.value.length,n.value.length));await title.press('Enter');
  assert.equal(await body.evaluate(n=>n===document.activeElement),true);
  assert.equal(await body.inputValue(),'Body');assert.ok((await source()).includes('Title\n'));
  await body.evaluate(n=>n.setSelectionRange(n.value.length,n.value.length));await body.press('Enter');
  assert.equal(await body.inputValue(),'Body\n\n');
  const beforeExit=await source();await body.press('Enter');
  assert.equal(await page.locator('#callout-fixture .cm-content').evaluate(n=>n===document.activeElement),true);
  await page.keyboard.type('Outside');assert.ok((await source()).endsWith('\n\nOutside'),await source());
  await page.evaluate(()=>e.undo());await page.evaluate(()=>e.undo());
  assert.equal(await source(),beforeExit);
  await page.evaluate(()=>e.redo());assert.ok(!(await source()).includes('> \n> '));
  await load('> [!note]\n> Body\n\n');
  await page.locator('#callout-fixture .leaf-callout-body .leaf-callout-preview').click();
  await body.evaluate(n=>n.setSelectionRange(n.value.length,n.value.length));await body.press('Shift+Enter');
  assert.equal(await body.inputValue(),'Body\\\n');
  const beforeComposition=await source();
  await body.evaluate(n=>n.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true})));
  assert.equal(await source(),beforeComposition);
  await load('> [!note]\n> Content\n\n');
  assert.equal(await body.inputValue(),'Content','user text is never stripped');
  await load('Selected text');
  await page.evaluate(()=>{e.view.dispatch({selection:{anchor:0,head:e.getValue().length}});e.format('callout-note');});
  await page.waitForFunction(()=>document.activeElement===document.querySelector('#callout-fixture .leaf-callout-title textarea'));
  assert.equal(await body.inputValue(),'Selected text');
  for(const nested of ['- item\n', '```\ncode\n']) {
   await load('> [!note]\n'+nested.split('\n').map(line=>'> '+line).join('\n')+'\n\n');
   await page.locator('#callout-fixture .leaf-callout-body .leaf-callout-preview').click();
   await body.evaluate(n=>n.setSelectionRange(n.value.length,n.value.length));
   await body.press('Enter');
   assert.equal(await body.evaluate(n=>n===document.activeElement),true,'nested structure stays inside');
  }
  const html=await page.evaluate(async()=>{const {renderPrintDocument}=await import('/src/print-document.js');const n=document.createElement('div');renderPrintDocument(n,'> [!note]\n> \n\n',{fallbackTitle:false});return n.textContent;});
  assert.doesNotMatch(html,/Content|内容|內容|enter_content/);
  console.log(engine.name()+': callout creation, title/body Enter, hard break, undo, IME guard and print passed');
  await page.close();
 } finally {await browser.close();}
}
