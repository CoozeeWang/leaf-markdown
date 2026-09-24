import {chromium, launchOptions} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// The assertion below compares the rendered footer against the declaration
// rather than a literal, so a bump that forgets to rebuild is caught here.
const declared=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 const version=page.locator('#settingsVersion'),build=page.locator('#settingsBuild');
 await page.click('#appearanceButton');
 assert.ok(await version.isVisible(),'the version shows in 设置');
 assert.equal(await version.textContent(),`Leaf ${declared}`);
 // "构建 2b4ee6e · 09-23 18:20"; the trailing + marks a build from a dirty tree.
 const stamp=await build.textContent();
 assert.match(stamp,/^构建 ([0-9a-f]{7,8}\+? · )?\d{2}-\d{2} \d{2}:\d{2}$/,'the build stamp carries a commit and a time');
 // The footer is outside the tabpanels, so it has to survive a tab switch.
 await page.click('#settingsTab-recovery');
 assert.ok(await version.isVisible(),'the version stays visible on 保存与恢复');
 assert.equal(await build.textContent(),stamp);
 await page.click('#settingsTab-appearance');
 assert.equal(await version.textContent(),`Leaf ${declared}`);
 assert.equal(await page.locator('#settingsBuild').isVisible(),true);
 assert.deepEqual(errors,[]);
 console.log('PASS version and build stamp in the 设置 footer, on both tabs');
}finally{await browser.close();}
