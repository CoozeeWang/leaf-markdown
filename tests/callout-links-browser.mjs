import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium,webkit} from 'playwright';
import {nativePage} from './ai-browser-fixture.mjs';
const cases=JSON.parse(await readFile(new URL('./app-link-cases.json',import.meta.url)));
const directory=await mkdtemp(join(tmpdir(),'leaf-callout-links-'));
try {
for(const engine of [chromium,webkit]) {
 const browser=await engine.launch({headless:true});
 try {
  for(const os of ['macos','windows']) {
   const page=await nativePage(browser,os);await page.keyboard.press('Escape');
   await page.evaluate(async()=>{
    const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
    window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));
    window.openedLinks=[];const invoke=window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke=(command,args)=>command==='open_link'?(openedLinks.push(args.target),Promise.resolve()):invoke(command,args);
   });
   const body=page.locator('.leaf-callout-body textarea');
   const load=async value=>page.evaluate(value=>{v.focus();v.dispatch({changes:{from:0,to:v.state.doc.length,insert:value},selection:{anchor:value.length}});},value);
   const source=()=>page.evaluate(()=>v.state.doc.toString());
   const paste=html=>body.evaluate((input,html)=>{
    const data=new DataTransfer();data.setData('text/html',html);data.setData('text/plain','合成访谈 '+html.match(/href="([^"]*)"/)?.[1]);
    return !input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
   },html);
   for(const url of cases.valid) {
    await load('> [!note]\n> Before replace after\n\n');
    await page.locator('.leaf-callout-body .leaf-callout-preview').click();
    await body.evaluate(n=>n.setSelectionRange(7,14));
    assert.equal(await paste(`<div>合成说话人 [00:10–00:20] (2)</div><p>合成正文</p><a href="${url}">合成访谈, 00:00, (5)</a>`),true);
    const value=await body.inputValue();
    assert.ok(value.startsWith('Before ') && value.endsWith(' after'));
    assert.ok(value.includes(`[合成访谈, 00:00, (5)](${url})`));
    assert.ok(value.includes('\\[00:10–00:20\\] (2)'));
    const saved=await source();
    await body.press('ControlOrMeta+z');
    assert.equal(await body.inputValue(),'Before replace after','one undo restores body');
    const file=join(directory,`${engine.name()}-${os}.md`);
    await writeFile(file,saved,'utf8');
    await load(await readFile(file,'utf8'));await body.blur();
    const link=page.locator('.leaf-callout-body [data-leaf-link]');
    assert.equal(await link.getAttribute('data-leaf-link'),url);
    assert.equal(await link.innerText(),'合成访谈, 00:00, (5)');
    assert.deepEqual(await page.evaluate(()=>openedLinks),[],'paste/reload must not open apps');
    await link.click();assert.deepEqual(await page.evaluate(()=>openedLinks),[],'plain edit click must not open apps');
    await link.click({modifiers:[os==='macos'?'Meta':'Control']});
    await page.waitForFunction(()=>openedLinks.length===1);
    assert.deepEqual(await page.evaluate(()=>openedLinks),[url]);
    await page.evaluate(()=>openedLinks=[]);
   }
   for(const url of cases.invalid) {
    await load('> [!note]\n> \n\n');
    await page.locator('.leaf-callout-body .leaf-callout-preview').click();
    await paste(`<a href="${url.replaceAll('&','&amp;').replaceAll('"','&quot;')}">label</a>`);
    assert.equal(await body.inputValue(),'label');
    assert.equal(await page.locator('.leaf-callout-body [data-leaf-link]').count(),0);
   }
   await load('> [!note]\n> Protected\n\n');
   await body.evaluate(n=>{n.focus();n.setSelectionRange(0,n.value.length);});
   await page.evaluate(()=>{window.originalGuard=v.assertDocumentMutationAllowed;v.assertDocumentMutationAllowed=()=>false;});
   assert.equal(await paste(`<a href="${cases.valid[0]}">blocked</a>`),true);
   assert.equal(await body.inputValue(),'Protected');
   await page.evaluate(()=>v.assertDocumentMutationAllowed=originalGuard);
   assert.deepEqual(await page.evaluate(()=>openedLinks),[]);
   await page.close();
   console.log(`${engine.name()}/${os}: callout HTML links, selection replacement/undo, reload, explicit mocked open, unsafe URLs and locked paste passed`);
  }
 } finally {await browser.close();}
}
} finally {await rm(directory,{recursive:true,force:true});}
