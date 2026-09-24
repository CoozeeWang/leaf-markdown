import {chromium,launchOptions} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.isTauri=true;window.nativeCalls=[];window.intervals=[];const interval=window.setInterval.bind(window);window.setInterval=(fn,ms)=>{intervals.push({fn,ms});return interval(fn,ms);};
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'document-test'},currentWebview:{label:'document-test'}},transformCallback:()=>1,invoke:async(command,args)=>{
   nativeCalls.push({command,args});
   if(command==='initial_path')return '/tmp/test.md';if(command==='read_document')return '# 原文\n\n正文';if(command==='recovery_list')return [];
   if(command==='plugin:event|listen')return 1;
   if(command==='recovery_retention'){if(args?.days){if(window.failSetting)throw '不能写入设置';localStorage.setItem('mock-retention',args.days);}return Number(localStorage.getItem('mock-retention')||30);}
   if(command==='recovery_expire')return 0;return null;
  }};
 });
 await page.goto('http://127.0.0.1:41732/?document=1');
 await page.waitForFunction(()=>nativeCalls.some(c=>c.command==='recovery_expire'));
 await page.click('#appearanceButton');await page.click('#settingsTab-recovery');const select=page.locator('#recoveryRetentionSelect');assert.equal(await select.inputValue(),'30');
 await select.selectOption('90');await page.waitForFunction(()=>nativeCalls.some(c=>c.command==='recovery_retention'&&c.args?.days===90));
 await page.waitForFunction(()=>!document.querySelector('#recoveryRetentionSelect').disabled);
 assert.equal(await select.inputValue(),'90');
 const before=await page.evaluate(()=>nativeCalls.filter(c=>c.command==='recovery_expire').length);
 await page.evaluate(()=>intervals.find(i=>i.ms===3600000).fn());
 assert.equal(await page.evaluate(()=>nativeCalls.filter(c=>c.command==='recovery_expire').length),before+1);
 await page.reload();await page.waitForFunction(()=>document.querySelector('#recoveryRetentionSelect')?.value==='90');
 await page.click('#appearanceButton');await page.click('#settingsTab-recovery');await page.evaluate(()=>window.failSetting=true);await select.selectOption('7');
 await page.waitForFunction(()=>!document.querySelector('#recoveryRetentionSelect').disabled);assert.equal(await select.inputValue(),'90');
 assert.deepEqual(errors,[]);console.log('PASS retention default, persisted settings, startup and hourly cleanup, setting failure rollback');
}finally{await browser.close();}
