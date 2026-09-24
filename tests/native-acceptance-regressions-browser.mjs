import assert from 'node:assert/strict';
import {chromium,launchOptions} from './browser-runtime.mjs';
import {webkit} from 'playwright';
for(const engine of ['chrome','webkit']) {
 const browser=await(engine==='webkit'?webkit.launch({headless:true}):chromium.launch(launchOptions));
 try {
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
  await page.locator('.cm-content').fill('第一段正文');await page.keyboard.press('End');
  const copy=await page.evaluate(async()=>{
   const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');const v=EditorView.findFromDOM(document.querySelector('.cm-content'));
   v.dispatch({selection:{anchor:v.state.doc.length}});v.focus();
   const d=new DataTransfer();d.setData('text/plain','已有剪贴板');
   for(const type of ['copy','cut'])v.contentDOM.dispatchEvent(new ClipboardEvent(type,{clipboardData:d,bubbles:true,cancelable:true}));
   return {text:d.getData('text/plain'),doc:v.state.doc.toString()};
  });assert.deepEqual(copy,{text:'已有剪贴板',doc:'第一段正文'});
  await page.evaluate(()=>window.open=()=>{window.exported=true;return {};});
  await page.keyboard.press('ControlOrMeta+e');assert.equal(await page.evaluate(()=>window.exported),true);
  await page.locator('.cm-content').fill('');await page.keyboard.type('---',{delay:30});
  await page.getByLabel('新属性名',{exact:true}).fill('作者');await page.getByLabel('新属性值',{exact:true}).fill('测试');await page.locator('.brand').click();
  assert.equal(await page.getByLabel('作者',{exact:true}).inputValue(),'测试');
  await page.getByRole('button',{name:'编辑此块 Markdown 源码',exact:true}).click();
  await page.getByLabel('文档属性源码',{exact:true}).press('Home');
  await page.keyboard.press('ArrowRight');await page.keyboard.press('Backspace');
  await page.keyboard.type('可继续编辑');
  await page.getByRole('button',{name:'返回实时渲染',exact:true}).click();
  assert.ok((await page.locator('.cm-content').innerText()).includes('可继续编辑'));
  await page.evaluate(async()=>{
   const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
   const v=EditorView.findFromDOM(document.querySelector('.cm-content'));
   v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'\n# 正文标题\n\n正文\n\n---\n\n后文'},selection:{anchor:0}});v.focus();
  });
  await page.keyboard.type('---',{delay:30});
  await page.getByLabel('新属性名',{exact:true}).waitFor();
  assert.ok((await page.locator('.cm-content').innerText()).includes('正文标题'));
  await page.getByRole('button',{name:'编辑此块 Markdown 源码',exact:true}).click();
  await page.getByRole('button',{name:'返回实时渲染',exact:true}).click();
  assert.ok(await page.getByRole('button',{name:'添加文档属性',exact:true}).isVisible());
  await page.getByRole('button',{name:'编辑此块 Markdown 源码',exact:true}).click();
  await page.getByLabel('文档属性源码',{exact:true}).fill('');
  await page.getByRole('button',{name:'返回实时渲染',exact:true}).click();
  assert.ok((await page.locator('.cm-content').innerText()).includes('正文标题'));
  assert.deepEqual(errors,[]);
  console.log(`PASS ${engine}: empty copy/cut, export shortcut, typed properties and separator deletion`);
 }finally{await browser.close();}
}
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage();await page.addInitScript(()=>{
  window.isTauri=true;window.calls=[];window.chosenPath=null;
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,invoke:async(cmd,args)=>{calls.push({cmd,args});if(cmd==='plugin:dialog|save')return chosenPath;if(cmd==='recovery_list')return [];if(cmd==='recovery_retention')return 30;return null;}};
 });
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');await page.waitForFunction(()=>calls.some(c=>c.cmd==='plugin:dialog|save'));
 assert.deepEqual(await page.evaluate(()=>calls.find(c=>c.cmd==='plugin:event|listen'&&c.args.event==='leaf-menu').args.target),{kind:'Window',label:'main'});
 assert.equal(await page.evaluate(()=>calls.some(c=>c.cmd==='new_document')),false);assert.ok(await page.locator('#welcomeScreen').isVisible());
 await page.evaluate(()=>chosenPath='/tmp/leaf-new-test.md');await page.click('#welcomeNewButton');await page.waitForFunction(()=>calls.some(c=>c.cmd==='open_document'));
 assert.deepEqual(await page.evaluate(()=>calls.filter(c=>['new_document','open_document'].includes(c.cmd)).map(c=>c.cmd)),['new_document','open_document']);
 assert.equal(await page.evaluate(()=>calls.find(c=>c.cmd==='new_document').args.path),'/tmp/leaf-new-test.md');
 console.log('PASS new document prompts before creation and cancellation leaves welcome intact');
}finally{await browser.close();}
