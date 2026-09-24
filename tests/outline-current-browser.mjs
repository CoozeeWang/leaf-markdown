import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 const source='开场正文\n\n'+Array.from({length:30},(_,i)=>`${'#'.repeat(i%6+1)} 章节${i}\n\n${'段落内容。'.repeat(80)}\n\n`).join('');
 await page.evaluate(async source=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source},selection:{anchor:0}});},source);
 await page.click('#outlineButton');
 const current=page.locator('.outline-item[aria-current=location]');
 assert.equal(await current.count(),0);
 await page.evaluate(()=>v.dispatch({selection:{anchor:v.state.doc.toString().indexOf('章节2')}}));
 await page.waitForFunction(()=>document.querySelector('.outline-item[aria-current]')?.textContent==='章节2');
 await page.locator('#outlineList').evaluate(e=>e.scrollTop=200);const scroll=await page.locator('#outlineList').evaluate(e=>e.scrollTop);
 await page.evaluate(()=>v.dispatch({selection:{anchor:v.state.doc.toString().indexOf('章节3')}}));
 await page.waitForFunction(()=>document.querySelector('.outline-item[aria-current]')?.textContent==='章节3');
 assert.equal(await page.locator('#outlineList').evaluate(e=>e.scrollTop),scroll);
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
 await page.locator('.reading-document h2').nth(1).evaluate(e=>e.scrollIntoView({block:'start'}));
 await page.waitForFunction(()=>document.querySelector('.outline-item[aria-current]')?.textContent==='章节7');
 assert.ok(!(await current.getAttribute('title')).includes('双击'));
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
 await page.waitForFunction(()=>document.querySelector('.outline-item[aria-current]')?.textContent==='章节3');
 assert.ok((await current.getAttribute('title')).includes('章节3\n单击跳转'));
 await page.click('#notesButton');await page.mouse.move(600,30);await page.locator('#outlineList').evaluate(e=>e.scrollTop=0);
 for(const theme of ['light','dark']) {
  await page.click('#appearanceButton');await page.click('#settingsTab-appearance');await page.selectOption('#themeSelect',theme);await page.click('#appearanceButton');await page.mouse.move(600,30);
  assert.equal(await page.locator('.outline-item').first().evaluate(e=>getComputedStyle(e).fontSize),'13px');
  assert.equal(await page.locator('.outline-item').first().evaluate(e=>getComputedStyle(e).fontWeight),'500');
  for(const side of ['outline','notes']) {
   const handle=page.locator(`.${side}-resizer`);
   assert.equal(await handle.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
   await page.keyboard.press('Tab');await handle.focus();assert.notEqual(await handle.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
   await page.locator('#headingButton').focus();
  }
  await page.screenshot({path:artifactPath(`outline-current-${theme}.png`)});
 }
 await page.setViewportSize({width:720,height:480});await page.click('#outlineButton');
 assert.equal(await current.textContent(),'章节3');
 assert.equal(await page.evaluate(()=>v.state.doc.toString()),source);assert.deepEqual(errors,[]);
 console.log('PASS current section in edit/read, no outline scroll stealing, mode tooltips, typography, quiet/focused resize handles, themes and narrow window');
}finally{await browser.close();}
