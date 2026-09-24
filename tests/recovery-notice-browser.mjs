import assert from 'node:assert/strict';
import {chromium,launchOptions} from './browser-runtime.mjs';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:720,height:480}});await page.clock.install();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.isTauri=true;window.entries=[{key:'doc',id:'draft',kind:'draft',source:'/tmp/示例.md',timestamp:1,bytes:10}];window.calls=[];window.saveFails=false;
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'document-test'},currentWebview:{label:'document-test'}},transformCallback:()=>1,invoke:async(cmd,args)=>{
   calls.push({cmd,args});if(cmd==='initial_path')return '/tmp/示例.md';if(cmd==='read_document'||cmd==='recovery_read')return '# 示例';
   if(cmd==='recovery_list')return entries;if(cmd==='recovery_retention')return 30;
   if(cmd==='rename_document')return '/tmp/'+args.name;
   if(cmd==='write_document'&&saveFails)throw '模拟保存失败';
   if(cmd==='recovery_delete'){entries=[];return;}return null;
  }};
 });
 await page.goto('http://127.0.0.1:41732/?document=1');await page.locator('#recoveryNotice').waitFor();
 await page.clock.runFor(4100);assert.equal(await page.locator('#saveStatus').textContent(),'');assert.ok(await page.locator('#recoveryNotice').isVisible());
 await page.locator('#recoveryNotice').click();await page.getByRole('dialog',{name:'历史版本与草稿',exact:true}).waitFor();
 await page.locator('[data-clear]').click();const confirm=page.getByRole('alertdialog');assert.ok(await confirm.isVisible());assert.match(await confirm.textContent(),/示例.md/);
 await page.keyboard.press('Enter');assert.ok(await confirm.isHidden());assert.equal(await page.evaluate(()=>calls.filter(c=>c.cmd==='recovery_delete').length),0);
 await page.locator('[data-clear]').click();await page.locator('[data-confirm-clear]').click();await page.waitForFunction(()=>document.querySelector('#recoveryNotice').hidden);
 assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.cmd==='recovery_delete').map(c=>c.args)),[{key:'doc',id:'draft'}]);await page.keyboard.press('Escape');
 await page.evaluate(async()=>{const {desktopRename}=await import('/src/desktop.js');await desktopRename('新名字.md');});assert.equal(await page.locator('#saveStatus').textContent(),'已重命名');
 await page.clock.runFor(60);assert.equal(await page.locator('#statusAnnouncement').textContent(),'已重命名');
 assert.equal(await page.locator('#statusAnnouncement').getAttribute('aria-live'),'polite');
 await page.evaluate(async()=>{const {desktopSave}=await import('/src/desktop.js');await desktopSave(false,false);});
 await page.clock.runFor(60);assert.equal(await page.locator('#statusAnnouncement').textContent(),'','background saves stay quiet');
 await page.evaluate(async()=>{const {desktopSave}=await import('/src/desktop.js');await desktopSave();});
 await page.clock.runFor(60);assert.equal(await page.locator('#statusAnnouncement').textContent(),'已保存');
 await page.clock.runFor(4100);assert.equal(await page.locator('#saveStatus').textContent(),'');
 await page.evaluate(async()=>{saveFails=true;const {desktopSave}=await import('/src/desktop.js');await desktopSave();});await page.clock.runFor(4100);assert.match(await page.locator('#saveStatus').textContent(),/尚未保存/);
 await page.evaluate(async()=>{saveFails=false;const {desktopSave}=await import('/src/desktop.js');await desktopSave();});assert.equal(await page.locator('#fileFeedback').textContent(),'');await page.clock.runFor(4100);assert.equal(await page.locator('#saveStatus').textContent(),'');
 assert.deepEqual(errors,[]);console.log('PASS direct scoped recovery entry, safe default cancel, immediate notice refresh, transient success and persistent errors');
} finally {await browser.close();}
