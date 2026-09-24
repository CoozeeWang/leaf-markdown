import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:720,height:480}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'正文'},selection:{anchor:0,head:2}});});
 await page.click('#commandsButton');
 assert.equal(await page.locator('.palette-group-title').nth(1).evaluate(el=>getComputedStyle(el).borderTopWidth),'1px');const input=page.locator('#paletteInput');
 assert.deepEqual(await page.locator('.palette-group-title').allTextContents(),['设置','文件','编辑','插入与格式','视图','恢复']);
 assert.deepEqual(await page.locator('#paletteList [role=group]').first().locator('button span').allTextContents(),['外观与排版','保存与恢复']);
 const exportItem=page.getByRole('option',{name:'导出 PDF'});
 await exportItem.hover();
 assert.equal(await page.locator('#paletteList button.selected').count(),1);
 assert.equal(await exportItem.getAttribute('aria-selected'),'true');
 assert.equal(await input.getAttribute('aria-activedescendant'),await exportItem.getAttribute('id'));
 await input.press('ArrowUp');
 assert.equal(await page.getByRole('option',{name:'保存与恢复',exact:true}).getAttribute('aria-selected'),'true');
 assert.equal(await exportItem.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
 await page.mouse.move(1,1);
 await input.fill('Callout');
 assert.equal(await page.locator('#paletteList button span').textContent(),'插入提示块');
 await input.fill('设置');
 // The 设置 group holds the two settings pages: 编辑与显示 moved out to the
 // toolbar's 显示 switchboard.
 assert.deepEqual(await page.locator('#paletteList button span').allTextContents(),['外观与排版','保存与恢复']);
 await input.fill('切换视图模式');assert.equal(await page.locator('#paletteList button').count(),1);
 await input.fill('');
 const count=await page.locator('#paletteList button').count();
 for(let i=1;i<count;i++) await input.press('ArrowDown');
 const last=page.locator('#paletteList button').last();
 assert.equal(await last.getAttribute('aria-selected'),'true');
 assert.equal(await input.getAttribute('aria-activedescendant'),await last.getAttribute('id'));
 const panel=await page.locator('.command-palette').boundingBox(),list=await page.locator('#paletteList').boundingBox(),item=await last.boundingBox();
 assert.ok(item.y>=list.y&&item.y+item.height<=list.y+list.height+1);assert.ok(list.y+list.height<=panel.y+panel.height);
 await page.screenshot({path:artifactPath('palette-last-narrow.png')});
 await input.fill('不可能存在的命令');assert.equal(await page.locator('#paletteList button').count(),0);assert.ok(await page.locator('#paletteEmpty').isVisible());assert.equal(await input.getAttribute('aria-activedescendant'),null);
 await input.press('Enter');assert.ok(await page.locator('#palette').isVisible());
 await input.fill('粗体');assert.equal(await page.locator('.palette-group-title').count(),0);
 await input.evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true})));
 assert.ok(await page.locator('#palette').isVisible());assert.equal(await page.evaluate(()=>v.state.doc.toString()),'正文');
 await input.press('Tab');assert.ok(await input.evaluate(e=>document.activeElement===e));
 await input.press('Enter');assert.ok(await page.locator('#palette').isHidden());assert.equal(await page.evaluate(()=>v.state.doc.toString()),'**正文**');
 await page.click('#undoButton');assert.equal(await page.evaluate(()=>v.state.doc.toString()),'正文');
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();await page.click('#commandsButton');await input.press('Escape');
 assert.equal(await page.evaluate(()=>document.activeElement.id),'readingPane');
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();await page.click('#commandsButton');await input.press('Escape');
 assert.ok(await page.locator('.cm-content').evaluate(e=>document.activeElement===e));
 for(const theme of ['light','dark']) {
  await page.click('#appearanceButton');await page.click('#settingsTab-appearance');await page.selectOption('#themeSelect',theme);await page.click('#appearanceButton');
  await page.click('#commandsButton');await page.screenshot({path:artifactPath(`palette-${theme}-narrow.png`)});await input.press('Escape');
 }
 assert.deepEqual(errors,[]);console.log('PASS grouped/filtered commands, final result fully visible, empty state, IME guard, active option semantics, focus containment/return, command execution/undo and themes');
}finally{await browser.close();}
