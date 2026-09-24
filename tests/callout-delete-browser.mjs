import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage(); await page.goto('http://127.0.0.1:41732'); await page.click('#welcomeNewButton');
 const original='前段\n\n> [!todo] 标题\n> 正文\n\n后段';
 await page.evaluate(async doc=>{
   const {createLeafEditor}=await import('/src/editor.js');
   document.querySelector('#editor').replaceChildren();
   window.fixture=createLeafEditor({parent:document.querySelector('#editor'),doc});
 },original);
 const source=()=>page.evaluate(()=>fixture.getValue());
 const checkDeleted=async()=>{assert.equal(await page.locator('.leaf-callout-widget').count(),0);assert.ok((await source()).includes('前段'));assert.ok((await source()).includes('后段'));};
 assert.equal(await page.locator('.leaf-callout-type-control option[value="__delete"]').count(),0);
 await page.locator('.leaf-callout-body > .leaf-callout-preview').click();
 await page.keyboard.press('Escape'); assert.equal(await page.locator('.leaf-block-selected').count(),1);
 await page.keyboard.press('Backspace'); await checkDeleted();
 await page.keyboard.press('ControlOrMeta+z'); assert.equal(await source(),original);
 await page.locator('.leaf-callout-body > .leaf-callout-preview').click();
 await page.getByRole('textbox',{name:'提示块内容',exact:true}).fill('');
 await page.keyboard.press('Backspace'); assert.equal(await page.locator('.leaf-callout-widget').count(),1);
 await page.locator('.leaf-callout-title > .leaf-callout-preview').click();
 await page.getByRole('textbox',{name:'提示块标题',exact:true}).fill('');
 const empty=await source(); await page.keyboard.press('Backspace'); await checkDeleted();
 await page.keyboard.press('ControlOrMeta+z'); assert.equal(await source(),empty);
 console.log('PASS no delete menu, Escape selection + Backspace, empty-block deletion, retained nonempty title, undo and neighbouring paragraphs');
} finally {await browser.close();}
