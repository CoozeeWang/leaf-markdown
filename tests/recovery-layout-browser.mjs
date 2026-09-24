import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser = await chromium.launch(launchOptions);
try {
 const page = await browser.newPage({viewport:{width:1100,height:820}});
 await page.route('**/recovery-layout', route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/style.css"></head><body><button id="origin">恢复入口</button></body></html>'}));
 await page.goto('http://127.0.0.1:41732/recovery-layout');
 await page.evaluate(async()=>{
  const {showRecovery}=await import('/src/recovery-dialog.js');
  window.calls=[];window.mode='normal';
  window.auditOpen=async()=>showRecovery({drafts:true,invoke:async(command,args)=>{
   calls.push({command,args});
   if(command==='recovery_list'){if(mode==='error')throw '测试读取失败';return mode==='empty'?[]:Array.from({length:12},(_,i)=>({key:'sample',id:String(i),source:'/审核样本/长文件夹名称/Leaf 与 Ripple 系列 UI 及视觉设计审核记录.md',kind:'draft',timestamp:1789268400000-i*3600000,bytes:15360}));}
   if(command==='recovery_read'){if(args.id==='1')await new Promise(r=>setTimeout(r,120));return '# 测试版本 '+args.id+'\n\n检查版本列表、源码预览和操作层级。';}
   if(command==='recovery_delete')throw '测试删除失败';
   if(command==='recovery_open')return;
   throw new Error(command);
  }});
  document.querySelector('#origin').focus();await auditOpen();
 });
 const list=page.getByRole('grid');
 const preview=page.getByRole('textbox',{name:'版本源码预览'});
 assert.equal(await page.locator('[aria-selected=true] .recovery-version-title').evaluate(el=>getComputedStyle(el).whiteSpace), 'normal');
 assert.equal(await page.locator('[aria-selected=true] .recovery-version-title').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
 await page.screenshot({path:artifactPath('recovery-new-light.png')});
 await page.locator('[data-delete-record]').nth(1).click();
 await page.locator('[data-confirm-clear]').click();
 await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('删除失败'));
 assert.equal(await page.evaluate(()=>calls.find(c=>c.command==='recovery_delete').args.id),'1','trash targets its own row, not the selected preview');
 await page.evaluate(()=>{calls.length=0;});
 await list.focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('End');
 await page.waitForFunction(()=>document.querySelector('textarea').value.startsWith('# 测试版本 11'));
 await page.waitForTimeout(180);
 assert.match(await preview.inputValue(),/^# 测试版本 11/,'stale preview cannot replace latest selection');
 assert.equal(await page.getByRole('row',{selected:true}).count(),1);
 await page.keyboard.press('Home');await page.waitForFunction(()=>document.querySelector('textarea').value.startsWith('# 测试版本 0'));
 await page.setViewportSize({width:720,height:480});
 const checkBounds=async()=>{
  assert.equal(await page.locator('.recovery-dialog').evaluate(el=>el.scrollHeight<=el.clientHeight+1),true);
  for(const selector of ['[data-apply]','[data-clear]','[data-close]'])if(await page.locator(selector).count())assert.equal(await page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.right<=innerWidth;}),true);
 };
 await checkBounds();await page.screenshot({path:artifactPath('recovery-new-narrow.png')});
 await page.locator('[data-clear]').click();await checkBounds();
 assert.equal(await page.locator('[data-apply]').isDisabled(),true);
 assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-cancel-clear')),true);
 assert.equal(await page.getByRole('alertdialog').isVisible(),true);
 await page.locator('[data-clear]').evaluate(el=>el.click());
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.command==='recovery_delete').length),0,'repeated trigger clicks cannot clear records');
 await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-confirm-clear')),true);
 await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-cancel-clear')),true);
 await page.locator('[data-apply]').evaluate(el=>el.click());
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.command==='recovery_open').length),0);
 await page.waitForTimeout(200);
 await page.screenshot({path:artifactPath('recovery-new-confirm.png')});
 await page.locator('[data-cancel-clear]').click();
 assert.equal(await page.locator('[data-apply]').isEnabled(),true);
 assert.equal(await page.locator('.recovery-confirm').isVisible(),false);
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.command==='recovery_delete').length),0);
 await page.locator('[data-clear]').click();await page.keyboard.press('Escape');
 assert.equal(await page.getByRole('dialog').count(),1);
 await page.locator('[data-clear]').click();await page.locator('[data-confirm-clear]').click();
 await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('删除失败'));
 assert.equal(await page.locator('[data-apply]').isEnabled(),true);
 await page.locator('[data-apply]').click();
 await page.waitForFunction(()=>!document.querySelector('.recovery-dialog'));
 assert.equal(await page.evaluate(()=>calls.find(c=>c.command==='recovery_open').args.id),'0');
 assert.equal(await page.evaluate(()=>document.activeElement.id),'origin');
 await page.evaluate(async()=>{mode='empty';await auditOpen();});
 assert.equal(await preview.isVisible(),false);assert.equal(await page.locator('[role=status]').innerText(),'暂无可恢复记录。');
 await checkBounds();await page.screenshot({path:artifactPath('recovery-new-empty.png')});
 await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-close')),true);
 await page.keyboard.press('Escape');
 await page.evaluate(async()=>{mode='error';await auditOpen();});
 assert.match(await page.locator('[role=status]').innerText(),/读取失败/);await page.keyboard.press('Escape');
 await page.setViewportSize({width:1100,height:820});
 await page.evaluate(async()=>{mode='normal';document.documentElement.dataset.theme='dark';await auditOpen();});
 await page.screenshot({path:artifactPath('recovery-new-dark.png')});
 console.log('PASS recovery layout, keyboard selection, async preview race, cancel and failed cleanup, draft opening, empty/error states');
}finally{await browser.close();}
