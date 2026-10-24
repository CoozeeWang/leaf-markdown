import assert from 'node:assert/strict';
import {webkit} from 'playwright';
import {chromium,launchOptions} from './browser-runtime.mjs';
const engine=process.env.LEAF_TOOLTIP_ENGINE||'chromium';
const browser=await(engine==='webkit'?webkit:chromium).launch(engine==='webkit'?{headless:true}:launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(process.env.LEAF_TEST_BASE_URL||'http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('#editor .cm-content'));});
 const source='Synthetic body.[^one]\n\n[^one]: Synthetic note.';
 await page.evaluate(text=>v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:0},filter:false}),source);
 const title=page.locator('.leaf-footnote-region-title'),note=page.locator('.leaf-endnote .cm-content').first(),tooltip=page.locator('#tooltip');
 for(const language of ['zh-Hans','zh-Hant-TW','en'])for(const theme of ['light','dark']) {
  const expected=await page.evaluate(async({language,theme})=>{
   const {setLanguagePreference,t}=await import('/src/i18n.js');await setLanguagePreference(language);document.documentElement.dataset.theme=theme;
   const {tooltipShortcutText}=await import('/src/platform-shortcuts.js');
   return {title:t('print_document.footnotes'),hint:t('editor.edit_footnote_hint'),tooltip:tooltipShortcutText(t('editor.edit_footnote_hint'))};
  },{language,theme});
  await page.mouse.move(0,0);await page.locator('#editor .cm-content').first().focus();
  assert.equal(await page.locator('.leaf-footnote-region-hint').count(),0);
  assert.equal(await page.locator('.leaf-footnote-region-head').innerText(),expected.title);
  assert.equal(await title.getAttribute('aria-description'),expected.hint);
  await title.hover();await tooltip.waitFor({state:'visible'});assert.equal(await tooltip.innerText(),expected.tooltip);
  await page.mouse.move(0,0);await tooltip.waitFor({state:'hidden'});
  await page.locator('#editor .cm-content').first().focus();await page.keyboard.press('Escape');
  for(let step=0;step<4&&!await title.evaluate(el=>el===document.activeElement);step++)await page.keyboard.press('Tab');
  assert.equal(await title.evaluate(el=>el===document.activeElement),true,'keyboard navigation reaches the title');
  assert.ok(await title.evaluate(el=>{const s=getComputedStyle(el);return s.outlineStyle==='solid'&&parseFloat(s.outlineWidth)>=2;}));
  await tooltip.waitFor({state:'visible'});assert.equal(await tooltip.innerText(),expected.tooltip);
  await page.keyboard.press('Tab');assert.equal(await note.evaluate(el=>el===document.activeElement),true);
  assert.equal(await note.getAttribute('contenteditable'),'false');
  await page.keyboard.press('Enter');assert.equal(await note.getAttribute('contenteditable'),'true');
  await page.keyboard.press('Escape');assert.equal(await note.getAttribute('contenteditable'),'false');
  await note.dblclick();assert.equal(await note.getAttribute('contenteditable'),'true');await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>v.state.doc.toString()),source);
 }
 // Adding a note still goes through the existing toolbar action and popup.
 await page.evaluate(()=>{v.dispatch({selection:{anchor:0}});v.focus();});
 await page.click('[data-format="footnote"]');await page.locator('.footnote-box textarea').waitFor({state:'visible'});
 assert.deepEqual(errors,[]);
 console.log(`${engine}: PASS 6 language/theme cases, title-only hover, keyboard hint, Enter/double-click edit, unchanged source and existing insertion`);
} finally {await browser.close();}
