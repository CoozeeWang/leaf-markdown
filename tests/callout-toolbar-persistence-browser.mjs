import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium,webkit} from 'playwright';

// Real toolbar and editor, with a disposable disk roundtrip of serialized Markdown.
// This does not replace native save-dialog or installed-app acceptance.
const directory=await mkdtemp(join(tmpdir(),'leaf-callout-synthetic-'));
try {
 for(const engine of [chromium,webkit]) {
  const browser=await engine.launch({headless:true});
  try {
   for(const [language,literal] of [['zh-Hans','内容'],['zh-Hant-TW','內容'],['en','Content']]) {
    const page=await browser.newPage();
    await page.goto('http://127.0.0.1:41732');
    await page.locator('#welcomeNewButton').click();
    await page.evaluate(async language=>{
     await (await import('/src/i18n.js')).setLanguagePreference(language);
     const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
     window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));
     v.dispatch({changes:{from:0,to:v.state.doc.length,insert:''},selection:{anchor:0}});v.focus();
    },language);
    await page.locator('#calloutButton').click();
    await page.locator('[data-format="callout-note"]').click();
    const title=page.locator('.leaf-callout-title textarea');
    const body=page.locator('.leaf-callout-body textarea');
    await title.waitFor({state:'visible'});
    assert.equal(await title.inputValue(),'');
    assert.ok(await title.getAttribute('placeholder'));
    await title.press('Enter');
    assert.equal(await body.evaluate(n=>n===document.activeElement),true);
    assert.equal(await body.inputValue(),'');
    assert.ok(await body.getAttribute('placeholder'));
    await body.blur();
    const source=()=>page.evaluate(()=>v.state.doc.toString());
    const empty=await source();
    assert.equal(empty.trim(),'> [!note]\n>');
    const file=join(directory,engine.name()+'-'+language+'.md');
    const reopen=async markdown=>{
     await writeFile(file,markdown,'utf8');
     const saved=await readFile(file,'utf8');
     await page.evaluate(saved=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:saved},selection:{anchor:saved.length}});},saved);
     assert.equal(await source(),saved);
    };
    await reopen(empty);
    assert.equal(await body.inputValue(),'');
    await page.locator('.leaf-callout-body .leaf-callout-preview').click();
    await body.fill(literal);
    await body.blur();
    assert.ok((await source()).includes('> '+literal));
    await reopen(await source());
    assert.equal(await body.inputValue(),literal,'genuine user content must survive');
    await reopen('> [!note]\n> 内容\n> 內容\n> Content\n\n');
    assert.equal(await body.inputValue(),'内容\n內容\nContent','existing literal words must not be removed');
    await page.close();
   }
   console.log(engine.name()+': trilingual toolbar, focus, UI-only hint, disk Markdown roundtrip and literal content passed');
  } finally {await browser.close();}
 }
} finally {await rm(directory,{recursive:true,force:true});}
