import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage();await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 const source='# 菜单边界验收\n\n测试正文';await page.locator('.cm-content').fill(source);
 const value=()=>page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');return EditorView.findFromDOM(document.querySelector('.cm-content')).state.doc.toString();});
 const bounds=async selector=>{const r=await page.locator(selector).boundingBox(),v=page.viewportSize();assert.ok(r.x>=8&&r.y>=8&&r.x+r.width<=v.width-8+.1&&r.y+r.height<=v.height-8+.1,`${selector} ${JSON.stringify(r)}`);assert.ok(await page.locator(selector).evaluate(e=>e.scrollWidth<=e.clientWidth));};
 for(const theme of ['light','dark'])for(const width of [1100,900,720]){
  const height=width===720?480:820;await page.setViewportSize({width,height});await page.click('#appearanceButton');await page.click('#settingsTab-appearance');await page.selectOption('#themeSelect',theme);await page.keyboard.press('Escape');
  await page.click('#readingToggle');await bounds('.mode-popover');assert.equal((await page.locator('.mode-popover').boundingBox()).width,160);
  await page.waitForTimeout(180);await page.screenshot({path:artifactPath(`bounded-mode-${theme}-${width}.png`)});
  await page.locator('[data-mode=reading]').click();assert.equal(await value(),source);await page.click('#readingToggle');await bounds('.mode-popover');await page.locator('[data-mode=edit]').click();assert.equal(await value(),source);
  for(const [trigger,popup] of [['documentMenuButton','#documentPopover'],['exportMenuButton','#exportPopover']]){await page.click('#'+trigger);await bounds(popup);await page.keyboard.press('End');await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),trigger);}
  await page.click('#calloutButton');await bounds('#calloutPopover');
  assert.equal((await page.locator('#calloutPopover').boundingBox()).width,260);
  const last=page.locator('#calloutPopover button').last();
  for(let i=1;i<await page.locator('#calloutPopover button').count();i++)await page.keyboard.press('Tab');
  assert.ok(await last.evaluate(e=>e===document.activeElement));
  const r=await last.boundingBox(),p=await page.locator('#calloutPopover').boundingBox();assert.ok(r.y>=p.y&&r.y+r.height<=p.y+p.height);
  await page.waitForTimeout(180);await page.screenshot({path:artifactPath(`bounded-callout-${theme}-${width}.png`)});
  await last.click();assert.notEqual(await value(),source);await page.click('#undoButton');assert.equal(await value(),source);
  await page.click('#readingToggle');await page.setViewportSize({width:width-1,height});await page.locator('.mode-popover').waitFor({state:'hidden'});await page.click('#readingToggle');await bounds('.mode-popover');await page.keyboard.press('Escape');
 }
 // The same placement policy flips above an anchor near the bottom edge.
 for(const [trigger,popup] of [['headingButton','#headingPopover'],['recentButton','#recentPopover'],['appearanceButton','#appearancePopover']]){await page.click('#'+trigger);await bounds(popup);await page.keyboard.press('Escape');await page.locator('.brand').click();}
 await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');const v=EditorView.findFromDOM(document.querySelector('.cm-content')),doc='| 名称 | 值 |\n| --- | --- |\n| 测试 | 内容 |\n\n表格后正文';v.dispatch({changes:{from:0,to:v.state.doc.length,insert:doc},selection:{anchor:doc.length}});});await page.locator('.brand').click();await page.locator('.leaf-table td').first().hover();await page.getByRole('button',{name:'行操作',exact:true}).click();await bounds('.leaf-table-menu');await page.keyboard.press('Escape');
 console.log('PASS menu bounds, width, last-item scrolling/activation/undo, mode source preservation, resize and upward placement');
} finally {await browser.close();}
