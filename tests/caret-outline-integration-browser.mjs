import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
const url=JSON.parse(await readFile(new URL('./app-link-cases.json',import.meta.url))).valid[0];
const a=`# A\n\n> [!note]\n> First\n> \n> [Synthetic, 00:00, (5)](${url})\n\n`,b='# B\n\nOther\n\n';
for(const engine of [chromium,webkit]) {
 const browser=await engine.launch({headless:true});
 try {
  const page=await browser.newPage();await page.goto('http://127.0.0.1:41732');await page.locator('#welcomeNewButton').click();
  await page.evaluate(async source=>{const {createLeafEditor}=await import('/src/editor.js');window.parseOutline=(await import('/src/outline-sections.js')).parseOutline;const host=document.createElement('div');host.id='integration';host.style.cssText='position:fixed;inset:30px;z-index:10000;background:white;overflow:auto';document.body.append(host);window.e=createLeafEditor({parent:host,doc:source});},a+b);
  const body=page.locator('#integration .leaf-callout-body textarea');
  const open=async()=>{if(await body.isVisible()) await body.focus(); else await page.locator('#integration .leaf-callout-body .leaf-callout-preview').click();await body.evaluate(n=>n.setSelectionRange(2,2));await page.waitForFunction(()=>{const n=document.querySelector('#integration .leaf-callout-body textarea');return n.classList.contains('leaf-measured-caret')&&getComputedStyle(n).caretColor==='rgba(0, 0, 0, 0)';});};
  await open();
  assert.equal(await page.evaluate(()=>{const h=parseOutline(e.getValue());return e.moveSection(e.view.state.doc,e.mutationDocumentGeneration(),h[0].from,h[1].from,'after');}),true);
  assert.equal(await page.evaluate(()=>e.getValue()),b+a);
  await open();assert.ok(await body.inputValue().then(v=>v.includes(url)));
  await page.keyboard.type('x');assert.ok((await body.inputValue()).startsWith('Fixrst'));
  await page.evaluate(()=>e.undo());assert.equal(await page.evaluate(()=>e.getValue()),b+a);
  await page.evaluate(()=>e.undo());assert.equal(await page.evaluate(()=>e.getValue()),a+b);
  await page.evaluate(()=>e.redo());assert.equal(await page.evaluate(()=>e.getValue()),b+a);
  await open();await body.blur();
  const link=page.locator('#integration .leaf-callout-body [data-leaf-link]');assert.equal(await link.getAttribute('data-leaf-link'),url);
  assert.equal(await link.innerText(),'Synthetic, 00:00, (5)');
  const saved=await page.evaluate(()=>e.getValue());await page.evaluate(value=>e.restoreValue(value),saved);await open();assert.equal(await page.evaluate(()=>e.getValue()),saved);
  console.log(`${engine.name()}: moved callout preserves deep-link source, measured caret, subsequent typing, isolated undo/redo and reload`);
 }finally{await browser.close();}
}
