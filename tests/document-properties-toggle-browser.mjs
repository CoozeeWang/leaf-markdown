import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const body=Array.from({length:80},(_,i)=>`第 ${i+1} 段正文，用来把属性区推出视野。`).join('\n\n');
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:720}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');

 await page.locator('.cm-content').fill(`---\ntitle: 属性开关\ntags:\n- 测试\n---\n\n${body}`);
 await page.waitForTimeout(300);
 // Filling leaves the caret at the end, which scrolls the region out of view.
 await page.evaluate(()=>{document.querySelector('.cm-scroller').scrollTop=0;});
 await page.waitForTimeout(200);

 const rows=page.locator('.leaf-property-row'),propertyBody=page.locator('.leaf-property-body');
 const switchboard=page.locator('#displayPopover'),propertiesSwitch=page.locator('#documentPropertiesToggle');
 const open=async()=>{await page.click('#displayButton');await page.waitForTimeout(200);};
 const close=async()=>{await page.click('#displayButton');await page.waitForTimeout(200);};
 const expanded=()=>page.evaluate(()=>{const b=document.querySelector('.leaf-property-body');return !!b&&!b.hidden;});

 // The display switches left the settings dialog for the toolbar switchboard.
 assert.ok(await expanded(),'properties start unfolded');
 await open();
 assert.ok(await switchboard.isVisible());
 assert.deepEqual(await switchboard.locator('.setting-check').allInnerTexts(),
   ['文档属性','正文上方的文件名','源码行号','编辑标记\n¶ 段落结束　↵ 换行','标题多级编号\n仅影响显示，不修改原文']);
 assert.equal(await propertiesSwitch.isChecked(),true,'the switch reports the region as shown');
 await page.screenshot({path:artifactPath('display-switchboard.png')});

 const rowCount=await rows.count();assert.ok(rowCount>0,'the sample document must have property rows');
 await propertiesSwitch.uncheck();await page.waitForTimeout(250);
 assert.equal(await expanded(),false,'unchecking folds the rows');
 assert.equal(await propertyBody.isVisible(),false);
 assert.equal(await rows.count(),rowCount,'folding must not remove a property');
 assert.ok(await switchboard.isVisible(),'the switchboard stays open while switches are flipped');
 await page.screenshot({path:artifactPath('display-properties-collapsed.png')});

 await propertiesSwitch.check();await page.waitForTimeout(250);
 assert.ok(await expanded(),'checking brings the rows back');
 assert.ok(await propertyBody.isVisible());
 await close();

 // Rows that are off screen keep reporting their real state: the switch is a
 // state readout, so it does not need the reveal the old press had to do.
 await page.evaluate(()=>{document.querySelector('.cm-scroller').scrollTop=1600;});
 await page.waitForTimeout(250);
 assert.equal(await propertyBody.isVisible(),false,'the sample document must scroll the rows off screen');
 await open();
 assert.equal(await propertiesSwitch.isChecked(),true,'off-screen rows are still reported as shown');
 await propertiesSwitch.uncheck();await page.waitForTimeout(250);
 assert.equal(await expanded(),false);
 await propertiesSwitch.check();await page.waitForTimeout(300);
 assert.ok(await propertyBody.isVisible(),'checking brings off-screen rows into view');
 await close();

 // The region's own header control folds the same rows, and reopening the
 // switchboard reports that rather than a remembered copy.
 await page.locator('.leaf-yaml .leaf-block-top button').first().click();await page.waitForTimeout(250);
 assert.equal(await expanded(),false);
 await open();
 assert.equal(await propertiesSwitch.isChecked(),false,'the switch reads the live state on open');
 await page.keyboard.press('Escape');await page.waitForTimeout(200);
 assert.ok(await switchboard.isHidden(),'Escape closes the switchboard');
 assert.equal(await page.evaluate(()=>document.activeElement.id),'displayButton','focus returns to the control');

 // Source mode shows the properties as YAML text, so there is nothing to fold.
 await page.locator('#readingToggle').click();
 await page.locator('.mode-popover [data-mode="source"]').click();
 await page.waitForTimeout(250);
 await open();
 assert.equal(await propertiesSwitch.isDisabled(),true,'source mode has no rows to fold');
 assert.equal(await switchboard.locator('#markerModeHint').innerText(),'源码模式仅显示换行标记 ↵。');
 await close();
 await page.locator('#readingToggle').click();
 await page.locator('.mode-popover [data-mode="edit"]').click();
 await page.waitForTimeout(250);

 // A document without properties has nothing to fold, so checking the switch
 // builds the region instead -- what the palette command has always done.
 await page.locator('.cm-content').fill('# 没有属性的文档\n');
 await page.waitForTimeout(250);
 await open();
 await propertiesSwitch.check();
 // Building the region focuses its first field, so wait for it rather than
 // sampling one frame after the press.
 await page.getByRole('textbox',{name:'新属性名',exact:true}).waitFor();
 await page.keyboard.press('Escape');
 await page.locator('.brand').click();
 await page.evaluate(()=>{document.querySelector('.cm-scroller').scrollTop=0;});
 await page.waitForTimeout(200);

 // The palette keeps its route to the region, which is what reading mode needs
 // now that the switch is disabled there.
 await page.click('#commandsButton');await page.fill('#paletteInput','文档属性');
 await page.getByRole('option',{name:'文档属性',exact:true}).click();
 // The command builds the region and unfolds it on the next frame, so wait for
 // the rows rather than sampling one frame after the press.
 await propertyBody.waitFor({state:'visible'});
 assert.ok(await expanded(),'the palette command reveals the region');
 assert.deepEqual(errors,[]);
 console.log('PASS display switchboard: switch reports live state, folds without losing rows, off-screen reveal, header mirror, source-mode disable, create, palette reveal');
} finally {await browser.close()}
