import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 for(const platform of ['MacIntel','Win32']) {
  const page=await browser.newPage({viewport:{width:1100,height:850}});
  await page.addInitScript(p=>Object.defineProperty(navigator,'platform',{get:()=>p}),platform);
  await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
  const original='# 测试\n\n| A | B |\n| --- | ---: |\n| one | two |\n| three | four |\n\n末段';
  await page.evaluate(async text=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:0}});},original);
  const source=()=>page.evaluate(()=>v.state.doc.toString());
  const mod=platform==='MacIntel'?'Meta':'Control';
  for(const direction of ['Left','Right','Up','Down']) {
   await page.locator('textarea[data-row="1"][data-col="0"]').focus();
   await page.keyboard.press(`${mod}+Alt+Arrow${direction}`);
   await page.waitForFunction(() => document.activeElement?.matches('textarea[data-row][data-col]'));
   assert.notEqual(await source(),original);
   assert.equal(await page.locator('textarea:focus').count(),1);
   await page.keyboard.press(`${mod}+z`);
   assert.equal(await source(),original);
  }
  assert.equal(await page.locator('.leaf-table-tools').count(),0);
  const cell=page.locator('td').first(),box=await cell.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height-2);
  await page.getByRole('button',{name:'在此插入行',exact:true}).click();
  assert.notEqual(await source(),original);await page.keyboard.press(`${mod}+z`);assert.equal(await source(),original);
  await page.locator('td').first().hover();await page.getByRole('button',{name:'行操作',exact:true}).click();
  assert.deepEqual(await page.locator('.leaf-table-menu button').allTextContents(),['删除此行','左侧添加列']);
  assert.equal(await page.locator('.leaf-table-menu button:focus').evaluate(e=>getComputedStyle(e).outlineStyle),'none');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('.leaf-table-menu button:focus').evaluate(e=>getComputedStyle(e).outlineStyle),'none');
  await page.waitForTimeout(180);
  assert.notEqual(await page.locator('.leaf-table-menu button:focus').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
  await page.getByRole('button',{name:'删除此行',exact:true}).click();
  assert.ok(!(await source()).includes('one'));assert.ok((await source()).includes('three'));
  await page.keyboard.press(`${mod}+z`);assert.equal(await source(),original);
  await page.locator('td').first().hover();await page.getByRole('button',{name:'列操作',exact:true}).click();
  assert.deepEqual(await page.locator('.leaf-table-menu button').allTextContents(),['删除此列','上方添加行']);
  await page.getByRole('button',{name:'删除此列',exact:true}).click();
  assert.ok(!(await source()).includes('one'));assert.ok((await source()).includes('two'));
  await page.keyboard.press(`${mod}+z`);assert.equal(await source(),original);
  for(const [handle,action] of [['行操作','左侧添加列'],['列操作','上方添加行']]){
   await page.locator('td').first().hover();await page.getByRole('button',{name:handle,exact:true}).click();
   await page.getByRole('button',{name:action,exact:true}).click();
   assert.ok((await source()).includes(action==='左侧添加列'?'|  | A | B |':'|  |  |\n| one | two |'));
   await page.keyboard.press(`${mod}+z`);assert.equal(await source(),original);
  }
  await page.locator('td').first().hover();await page.screenshot({path:artifactPath(`leaf-table-edges-${platform}.png`)});
  await page.close();
 }
 console.log('PASS Mac/Windows insertion shortcuts, focus, edge insertion, row deletion and undo');
} finally {await browser.close();}
