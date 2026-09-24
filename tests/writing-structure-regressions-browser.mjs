import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});
 const setup=async text=>page.evaluate(text=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:text.length}});v.focus();},text);
 const source=()=>page.evaluate(()=>v.state.doc.toString());
 for(const marker of ['-','1.']){
  const list=Array.from({length:5},(_,i)=>'  '.repeat(i)+marker+' 测试列表 '+(i+1)).join('\n');
  await setup(list);await page.keyboard.press('Enter');
  for(let i=0;i<4;i++)await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Backspace');await page.keyboard.type('body');await page.keyboard.press('Enter');await page.keyboard.type('next');
  assert.ok((await source()).endsWith('\n\nbody\nnext'),await source());
 }
 const nested=Array.from({length:5},(_,i)=>'  '.repeat(i)+'- list '+i).join('\n');
 await setup(nested+'\n\n| A | B |\n| --- | --- |\n| one | two |\n\nFollowing prose.');
 await page.evaluate(head=>{v.dispatch({selection:{anchor:head}});v.focus();},nested.length);
 await page.keyboard.press('Enter');
 for(let i=0;i<4;i++)await page.keyboard.press('Shift+Tab');
 await page.keyboard.press('Backspace');await page.keyboard.type('body');await page.keyboard.press('Enter');await page.keyboard.type('next');
 assert.ok((await source()).includes('\n\nbody\nnext\n\n| A'),await source());
 await setup('- one\n  - two\n       ');await page.keyboard.press('Enter');await page.keyboard.type('body');
 assert.ok((await source()).endsWith('\n\nbody'),await source());
 const table='# Table\n\n| A | B |\n| --- | --- |\n| one | two |\n| three | four |';
 await setup(table);
 await page.locator('td .leaf-cell-preview').first().click();
 await page.keyboard.press('ControlOrMeta+a');await page.keyboard.type('alpha beta');await page.keyboard.press('Enter');await page.keyboard.type('gamma');
 assert.equal(await page.locator('textarea[data-row="1"][data-col="0"]').inputValue(),'alpha beta\ngamma');
 assert.ok((await source()).includes('alpha beta<br>gamma'),await source());
 for(let i=0;i<30;i++){
  const row=1+(i%2),col=i%2;
  await page.locator('.leaf-table tr').nth(row).locator('td').nth(col).click();
  await page.keyboard.press('ControlOrMeta+a');await page.keyboard.type(`word ${i}`);
  assert.equal(await page.evaluate(()=>document.activeElement.value),`word ${i}`);
  assert.ok(await page.evaluate(()=>document.activeElement.isConnected));
 }
 await page.getByRole('button',{name:'行操作',exact:true}).click();
 await page.getByRole('button',{name:'删除此行',exact:true}).click();
 assert.equal(await page.locator('.leaf-table tr').count(),2);
 await page.getByRole('button',{name:'在表格后继续正文',exact:true}).click();
 await page.keyboard.type('after table');await page.keyboard.press('Enter');await page.keyboard.type('second paragraph');
 assert.ok((await source()).endsWith('\n\nafter table\nsecond paragraph'),await source());
 await page.screenshot({path:artifactPath('leaf-structure-regressions.png')});
 assert.deepEqual(errors,[]);console.log('PASS nested list exit, orphan indentation, table spaces/newlines, repeated cell editing, row removal and following prose');
}finally{await browser.close();}
