import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:720,height:480}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');await page.click('#appearanceButton');
 const panel=page.locator('#appearancePopover'),scroll=page.locator('.appearance-scroll');
 assert.equal(await page.evaluate(()=>document.activeElement.id),'settingsTab-appearance');
 assert.equal(await panel.locator('legend').count(),0);
 assert.deepEqual(await panel.locator('.appearance-group').evaluateAll(es=>es.map(e=>e.getAttribute('aria-label'))),['主题','正文排版']);
 assert.equal(await scroll.evaluate(e=>e.scrollWidth>e.clientWidth),false);
 await page.screenshot({path:artifactPath('appearance-grouped-top.png')});
 await page.click('#settingsTab-appearance');await page.locator('#contentWidthInput').scrollIntoViewIfNeeded();
 const bottom=await page.locator('#contentWidthInput').boundingBox();assert.ok(bottom.y+bottom.height<480);
 await page.screenshot({path:artifactPath('appearance-grouped-bottom.png')});
 await panel.press('Escape');assert.ok(await panel.isHidden());assert.equal(await page.evaluate(()=>document.activeElement.id),'appearanceButton');
 // 标题多级编号 lives in the toolbar's 显示 switchboard with the other display
 // switches, and the switch has to survive a mode switch. What it renders is
 // checked in toolbar-menus, on a document that has a heading to number.
 await page.click('#displayButton');await page.locator('#headingNumberSetting').check();await page.click('#displayButton');
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();assert.equal(await page.locator('#headingNumberSetting').isChecked(),true);
 await page.click('#appearanceButton');await page.click('#settingsTab-appearance');await page.selectOption('#fontFamilySelect','serif');
 await page.locator('#fontSizeInput').focus();await page.keyboard.press('ArrowRight');
 const value=await page.locator('#fontSizeInput').inputValue();assert.equal(await page.locator('#fontSizeValue').textContent(),value+'px');
 await page.locator('#fontSizeInput').press('Escape');assert.ok(await panel.isHidden());
 await page.click('#appearanceButton');await panel.evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true})));assert.ok(await panel.isVisible());
 await panel.press('Escape');await page.reload();await page.click('#welcomeNewButton');await page.click('#appearanceButton');
 assert.equal(await page.locator('#fontSizeInput').inputValue(),value);assert.equal(await page.locator('#fontFamilySelect').inputValue(),'serif');
 await page.click('#settingsTab-appearance');await page.selectOption('#themeSelect','dark');await scroll.evaluate(e=>e.scrollTop=0);await page.screenshot({path:artifactPath('appearance-grouped-dark.png')});
 assert.deepEqual(errors,[]);console.log('PASS appearance groups, scroll hint and bottom reachability, keyboard focus/Escape, composition guard, reading sync and persisted values');
}finally{await browser.close();}
