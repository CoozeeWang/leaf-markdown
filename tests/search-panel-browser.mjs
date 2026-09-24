import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 const source='写作 写作 写作\n\nAlpha alpha alphabet\n\n编号12 编号34\n\nbanana';
 await page.evaluate(async source=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source},selection:{anchor:0}});},source);
 const text=()=>page.evaluate(()=>v.state.doc.toString());
 await page.click('#searchButton');
 const field=page.locator('.cm-search input[name=search]'),result=page.locator('.search-result');
 const button=name=>page.locator(`.cm-search button[name=${name}]`);
 assert.equal(await page.locator('.leaf-search-replace').isVisible(),false);
 assert.equal(await result.textContent(),'输入查找内容');assert.ok(await button('next').isDisabled());
 await field.fill('写作');assert.equal(await result.textContent(),'共 3 处');
 await field.press('Enter');assert.equal(await result.textContent(),'第 1 / 3 处');
 await field.press('Enter');assert.equal(await result.textContent(),'第 2 / 3 处');
 await field.press('Shift+Enter');assert.equal(await result.textContent(),'第 1 / 3 处');
 await button('toggleReplace').click();await page.locator('input[name=replace]').fill('阅读');
 await button('replace').click();assert.equal(await text(),source.replace('写作','阅读'));
 await page.click('#undoButton');assert.equal(await text(),source);
 await button('replaceAll').click();assert.equal(await text(),source.replaceAll('写作','阅读'));assert.equal(await result.textContent(),'无匹配');
 await page.click('#undoButton');assert.equal(await text(),source);
 await field.fill('不存在');assert.equal(await result.textContent(),'无匹配');assert.ok(await button('replaceAll').isDisabled());
 await button('options').click();await page.locator('label:has(input[name=re])').click();
 await field.fill('[');assert.equal(await result.textContent(),'正则表达式无效');assert.equal(await field.getAttribute('aria-invalid'),'true');
 await field.fill('编号(\\d+)');await page.locator('input[name=replace]').fill('序号$1');
 assert.equal(await result.textContent(),'共 2 处');await button('replaceAll').click();assert.ok((await text()).includes('序号12 序号34'));
 await page.click('#undoButton');assert.equal(await text(),source);
 await page.locator('label:has(input[name=re])').click();await field.fill('alpha');assert.equal(await result.textContent(),'共 3 处');
 await page.locator('label:has(input[name=word])').click();assert.equal(await result.textContent(),'共 2 处');
 await page.locator('label:has(input[name=case])').click();assert.equal(await result.textContent(),'共 1 处');
 await button('select').click();assert.equal(await page.evaluate(()=>v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to)),'alpha');
 await button('toggleReplace').click();await button('options').click();
 for(const theme of ['light','dark']) {
  await page.click('#appearanceButton');await page.click('#settingsTab-appearance');await page.selectOption('#themeSelect',theme);await page.click('#appearanceButton');
  await page.screenshot({path:artifactPath(`search-panel-${theme}.png`)});
 }
 await page.setViewportSize({width:720,height:480});await button('toggleReplace').click();await button('options').click();
 for(const el of await page.locator('.cm-search button:visible,.cm-search input:visible').all()) {const r=await el.boundingBox();assert.ok(r.x>=0&&r.x+r.width<=720);}
 await page.screenshot({path:artifactPath('search-panel-narrow.png')});
 await field.focus();await field.press('Escape');assert.equal(await page.locator('.cm-search').count(),0);assert.ok(await page.locator('.cm-content').evaluate(e=>e===document.activeElement));
 assert.equal(await text(),source);assert.deepEqual(errors,[]);
 console.log('PASS compact/expanded search, counts/navigation, no results/invalid regex, replace/replace-all/undo, regex groups, options, select matches, themes/narrow and Escape focus');
}finally{await browser.close();}
