import {chromium, launchOptions} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:800}}), errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 for(const theme of ['light','dark']) {
  await page.click('#appearanceButton');await page.click('#settingsTab-appearance');await page.selectOption('#themeSelect',theme);await page.click('#appearanceButton');
  for(const size of [{width:1100,height:800},{width:720,height:480}]) {
   await page.setViewportSize(size);
   for(const format of ['strike','sup','sub','code','codeblock']) assert.ok(await page.locator(`.format-toolbar [data-format=${format}]`).isVisible());
   if(process.env.LEAF_UI_REVIEW_SHOTS) await page.screenshot({path:`${process.env.LEAF_UI_REVIEW_SHOTS}/50-toolbar-${theme}-${size.width}-browser.png`});
   for(const [trigger,popup,first] of [['documentMenuButton','documentPopover','documentHistory'],['exportMenuButton','exportPopover','exportButton']]) {
    await page.click('#'+trigger);
    await page.waitForTimeout(180);
    const focusStyle=await page.locator('#'+first).evaluate(el=>{const s=getComputedStyle(el);return {outline:s.outlineStyle,shadow:s.boxShadow,bg:s.backgroundColor};});
    assert.equal(focusStyle.outline,'none');assert.equal(focusStyle.shadow,'none');assert.notEqual(focusStyle.bg,'rgba(0, 0, 0, 0)');
    assert.equal(await page.locator('#'+popup+' button').first().evaluate(el=>getComputedStyle(el).fontSize),'13px');
    if(process.env.LEAF_UI_REVIEW_SHOTS) await page.screenshot({path:`${process.env.LEAF_UI_REVIEW_SHOTS}/51-${popup}-${theme}-${size.width}-browser.png`});
    assert.equal(await page.evaluate(()=>document.activeElement.id),first);
    const rect=await page.locator('#'+popup).boundingBox();
    assert.ok(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=size.width&&rect.y+rect.height<=size.height);
    // Arrow navigation needs a second row to land on; in the web build the
    // bundle export stays hidden, so a one-row menu must simply keep its focus.
    if(await page.locator('#'+popup+' button:visible').count()>1){await page.keyboard.press('ArrowDown');assert.notEqual(await page.evaluate(()=>document.activeElement.id),first);}
    else{await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.id),first,'a single-row menu keeps focus');}
    await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>document.activeElement.id),first);
    await page.keyboard.press('End');await page.keyboard.press('Tab');
    assert.ok(await page.locator('#'+popup).isHidden(),'Tab leaves menu without hidden focus');
    await page.click('#'+trigger);await page.keyboard.press('Escape');
    assert.ok(await page.locator('#'+popup).isHidden());assert.equal(await page.evaluate(()=>document.activeElement.id),trigger);
   }
   await page.click('#calloutButton');await page.keyboard.press('Escape');
   assert.equal(await page.evaluate(()=>document.activeElement.id),'calloutButton');
   await page.click('#displayButton');await page.locator('#headingNumberSetting').check();await page.click('#displayButton');
   // 标题多级编号 is one row in the 显示 switchboard now, with no toolbar button
   // of its own, so check it by what it does: give the document a heading and
   // read the number off the reading pane.
   await page.evaluate(async () => {
     const { EditorView } = await import('/node_modules/@codemirror/view/dist/index.js');
     const v = EditorView.findFromDOM(document.querySelector('.cm-content'));
     v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '# 编号标题\n\n正文\n' }, selection: { anchor: 0 } });
   });
   const headingNumbers = () => page.locator('#readingPane .print-heading-number');
   await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
   await headingNumbers().first().waitFor({state:'visible'});
   assert.equal(await headingNumbers().count(),1,'reading mode numbers the heading while the switch is on');
   // Reading mode keeps the switchboard, which is the only place left to turn
   // this back off.
   await page.click('#displayButton');await page.locator('#headingNumberSetting').uncheck();await page.click('#displayButton');
   await headingNumbers().first().waitFor({state:'detached'});
   assert.equal(await headingNumbers().count(),0,'turning the switch off removes the number');
   await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
  }
 }
 assert.deepEqual(errors,[]);console.log('PASS permanent formats, menu bounds, keyboard navigation/escape/tab and shared numbering in light/dark, regular/minimum windows');
} finally {await browser.close();}
