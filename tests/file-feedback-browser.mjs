import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try{
 const page=await browser.newPage({viewport:{width:720,height:480}});
 await page.addInitScript(()=>{
  window.isTauri=true;window.callbacks={};window.handlers={};window.calls=[];let id=0;
  window.saveMode='fail';
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'document-test'},currentWebview:{label:'document-test'}},transformCallback:fn=>{callbacks[++id]=fn;return id;},invoke:async(command,args)=>{
   calls.push({command,args});
   if(command==='plugin:event|listen'){handlers[args.event]=callbacks[args.handler];return 1;}
   if(command==='initial_path')return '/审核样本/文件提示审核.md';
   if(command==='read_document')return '# 文件提示审核\n\n测试正文';
   if(command==='recovery_list')return [{kind:'draft'}];
   if(command==='recovery_retention')return 30;
   if(command==='write_document'&&saveMode==='fail')throw '文件已被其他程序修改，请另存为以保留当前编辑内容。';
   return null;
  }};
 });
 await page.goto('http://127.0.0.1:41732/?document=1');
 await page.waitForFunction(()=>document.querySelector('#saveNotice')?.textContent.includes('已开启自动保存'));
 assert.equal(await page.locator('#saveStatus').innerText(),'','the save-mode notice must live in the statusbar, not under the topbar filename');
 assert.equal(await page.locator('#fileFeedback').innerText(),'','an opened document with recovery records must not request a save location');
 await page.evaluate(async()=>{const {desktopSave}=await import('/src/desktop.js');await desktopSave();});
 assert.match(await page.locator('#fileFeedback').innerText(),/尚未保存/);
 assert.equal(await page.locator('#fileFeedback').isVisible(),true);
 assert.equal(await page.locator('#fileFeedback').evaluate(el=>el.getBoundingClientRect().right<=innerWidth),true);
 await page.screenshot({path:artifactPath('file-feedback-narrow.png')});
 await page.evaluate(async()=>{const {desktopRestore}=await import('/src/desktop.js');await desktopRestore('# 需要保存的修改');});
 assert.match(await page.locator('#fileFeedback').innerText(),/尚未保存/,'manual feedback cannot hide an unresolved error');
 await page.evaluate(()=>{handlers['leaf-close']({});});
 await page.getByRole('alertdialog').waitFor();
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.choice),'save');
 await page.screenshot({path:artifactPath('close-document-light.png')});
 await page.keyboard.press('Escape');
 assert.equal(await page.getByRole('alertdialog').count(),0);
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.command==='plugin:window|destroy').length),0);
 await page.evaluate(()=>{handlers['leaf-close']({});});
 await page.getByRole('button',{name:'保存并关闭',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.close-document-dialog'));
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.command==='plugin:window|destroy').length),0,'failed save leaves window open');
 await page.evaluate(async()=>{saveMode='ok';const {desktopSave}=await import('/src/desktop.js');await desktopSave();});
 assert.equal(await page.locator('#fileFeedback').innerText(),'');
 await page.evaluate(async()=>{const {desktopRestore}=await import('/src/desktop.js');await desktopRestore('# 第二次修改');handlers['leaf-close']({});});
 await page.getByRole('alertdialog').waitFor();
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');
 await page.waitForTimeout(200);
 await page.screenshot({path:artifactPath('close-document-dark.png')});
 await page.getByRole('button',{name:'保存并关闭',exact:true}).click();
 await page.waitForFunction(()=>calls.some(c=>c.command==='plugin:window|destroy'));
 // An untitled document invokes the save chooser, whose cancellation must retain it.
 const blank=await browser.newPage({viewport:{width:720,height:480}});
 await blank.addInitScript(()=>{
  window.isTauri=true;window.callbacks={};window.handlers={};window.calls=[];let id=0;
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'document-test'},currentWebview:{label:'document-test'}},transformCallback:fn=>{callbacks[++id]=fn;return id;},invoke:async(command,args)=>{
   calls.push({command,args});
   if(command==='plugin:event|listen'){handlers[args.event]=callbacks[args.handler];return 1;}
   if(command==='initial_path'||command==='recovery_initial'||command==='plugin:dialog|save')return null;
   if(command==='recovery_list')return [];if(command==='recovery_retention')return 30;
   return null;
  }};
 });
 await blank.goto('http://127.0.0.1:41732/?document=1');
 await blank.waitForFunction(()=>handlers['leaf-close']&&document.querySelector('.shell')?.style.pointerEvents==='');
 await blank.evaluate(async()=>{const {desktopRestore}=await import('/src/desktop.js');await desktopRestore('未命名文档的修改');handlers['leaf-close']({});});
 await blank.getByRole('button',{name:'保存并关闭',exact:true}).click();
 await blank.waitForFunction(()=>calls.some(c=>c.command==='plugin:dialog|save'));
 assert.equal(await blank.evaluate(()=>calls.filter(c=>c.command==='plugin:window|destroy').length),0);
 await blank.evaluate(()=>{handlers['leaf-close']({});});
 await blank.getByRole('button',{name:'不保存并关闭',exact:true}).click();
 await blank.waitForFunction(()=>calls.some(c=>c.command==='plugin:window|destroy'));
 assert.equal(await blank.evaluate(()=>calls.filter(c=>c.command==='write_document').length),0);
 console.log('PASS narrow feedback, error persistence, successful save clearing, close cancel/failure/success and cancelled save chooser');
}finally{await browser.close();}
