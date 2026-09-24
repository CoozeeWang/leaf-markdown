import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:760}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');
 await page.locator('.welcome-mark').evaluate(el=>el.decode());
 await page.screenshot({path:artifactPath('leaf-welcome-light.png')});
 const buttons=await page.locator('.welcome-actions button').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {height:r.height,top:r.top,right:r.right}}));
 assert.equal(buttons.length,3);assert.ok(buttons.every(b=>b.height===44&&b.top===buttons[0].top));
 assert.equal(await page.locator('.welcome-title').textContent(),'Leaf轻量 Markdown 编辑器');
 assert.ok(await page.locator('.welcome-name').evaluate(el=>getComputedStyle(el).fontFamily.startsWith('Palatino')));
 assert.ok(await page.locator('.welcome-drop-hint').evaluate(el=>el.getBoundingClientRect().bottom>innerHeight-60));
 await page.hover('#welcomeRecentButton');await page.waitForTimeout(500);
 assert.ok(await page.locator('#tooltip').isVisible());
 await page.click('#welcomeRecentButton');assert.ok(await page.locator('#recentPopover').isVisible());
 await page.click('.welcome-title');assert.equal(await page.locator('#recentPopover').isVisible(),false);
 await page.setViewportSize({width:720,height:480});
 await page.screenshot({path:artifactPath('leaf-welcome-small.png')});
 assert.ok(await page.locator('.welcome-actions').evaluate(el=>el.getBoundingClientRect().right<innerWidth));
 await page.emulateMedia({colorScheme:'dark'});
 await page.waitForTimeout(300);
 await page.screenshot({path:artifactPath('leaf-welcome-dark.png')});
 // Desktop recovery availability is supplied by the native bridge. Exercise
 // the welcome UI with a controllable bridge, including cleanup and failure.
 await page.evaluate(async()=>{
  const {setupWelcomeRecovery}=await import('/src/recovery-dialog.js');
  window.drafts=[];
  setupWelcomeRecovery({welcome:document.querySelector('#welcomeScreen'),invoke:async command=>{
   if(command==='recovery_list'){if(window.failDraftRead)throw Error('read failed');return window.drafts;}
   if(command==='recovery_read')return '# 可恢复内容';
   if(command==='recovery_delete'){window.drafts=[];return;}
  }});
 });
 assert.equal(await page.locator('.welcome-recovery-hint').isVisible(),false);
 const before=await page.locator('.welcome-actions').boundingBox();
 await page.evaluate(()=>{window.drafts=[{key:'draft',id:'one',kind:'draft',timestamp:Date.now(),bytes:20}];window.dispatchEvent(new Event('focus'));});
 await page.locator('.welcome-recovery-hint').waitFor({state:'visible'});
 assert.equal(await page.locator('.welcome-actions button').count(),3);
 assert.deepEqual(await page.locator('.welcome-actions').boundingBox(),before);
 await page.screenshot({path:artifactPath('leaf-welcome-recovery-dark.png')});
 await page.emulateMedia({colorScheme:'light'});
 await page.setViewportSize({width:1100,height:760});
 await page.waitForTimeout(300);
 await page.screenshot({path:artifactPath('leaf-welcome-recovery-light.png')});
 await page.getByRole('button',{name:'查看可恢复的草稿'}).click();
 assert.equal(await page.getByRole('textbox',{name:'版本源码预览'}).inputValue(),'# 可恢复内容');
 await page.getByRole('button',{name:'删除该草稿',exact:true}).click();
 await page.getByRole('alertdialog').getByRole('button',{name:'删除该草稿',exact:true}).click();
 await page.getByRole('button',{name:'关闭恢复窗口'}).click();
 await page.locator('.welcome-recovery-hint').waitFor({state:'hidden'});
 await page.evaluate(()=>{window.failDraftRead=true;window.dispatchEvent(new Event('focus'));});
 assert.equal(await page.locator('.welcome-recovery-hint').isVisible(),false);
 await page.click('#welcomeNewButton');assert.equal(await page.locator('#welcomeScreen').isVisible(),false);
 await page.reload();
 await page.locator('#welcomeNewButton').waitFor({state:'visible'});
 await page.evaluate(()=>{
  const dt=new DataTransfer();dt.items.add(new File(['# 拖放测试\n\n正文'],'drop-test.md',{type:'text/markdown'}));
  window.dispatchEvent(new DragEvent('dragenter',{bubbles:true,dataTransfer:dt}));
 });
 assert.ok(await page.locator('.drop-overlay').evaluate(el=>el.classList.contains('visible')));
 await page.evaluate(()=>{
  const dt=new DataTransfer();dt.items.add(new File(['# 拖放测试\n\n正文'],'drop-test.md',{type:'text/markdown'}));
  window.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}));
 });
 await page.waitForTimeout(300);
 assert.equal(await page.locator('#welcomeScreen').isVisible(),false);
 assert.ok((await page.locator('.cm-content').innerText()).includes('拖放测试'));
 const native=await browser.newPage();
 native.on('pageerror',e=>errors.push(e.message));
 await native.addInitScript(()=>{
  window.isTauri=true;window.nativeCalls=[];
  localStorage.setItem('leaf-desktop-recent', JSON.stringify([
   {name:'同名.md',path:'/Users/test/项目 A/同名.md'},
   {name:'同名.md',path:'/Users/test/项目 B/同名.md'},
   {name:'根目录.md',path:'C:\\根目录.md'},
   {name:'无路径.md'},
  ]));
  window.__TAURI_INTERNALS__={
   metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
   transformCallback:()=>1,
   invoke:async(command,args)=>{
    window.nativeCalls.push({command,args});
    if(command==='initial_path')return null;
    if(command==='plugin:dialog|save')return '/Users/test/新建.md';
    if(command==='recovery_list')return new Promise(resolve=>setTimeout(()=>resolve([]),500));
    if(command==='plugin:event|listen')return 1;
    return null;
   },
  };
 });
 await native.goto('http://127.0.0.1:41732');
 await native.click('#welcomeRecentButton');
 assert.deepEqual(await native.locator('.recent-file-directory').allTextContents(),['/Users/test/项目 A','/Users/test/项目 B','C:\\']);
 assert.equal(await native.locator('#recentList button').nth(1).getAttribute('title'),'/Users/test/项目 B/同名.md');
 assert.equal(await native.locator('#recentList button').nth(3).innerText(),'无路径.md');
 await native.setViewportSize({width:720,height:480});
 await native.waitForFunction(()=>document.querySelector('#recentPopover').hidden);
 await native.click('#welcomeRecentButton');
 assert.ok(await native.locator('#recentPopover').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
 await native.locator('#recentList button').nth(1).click();
 await native.waitForFunction(()=>nativeCalls.some(c=>c.command==='open_document'&&c.args.path==='/Users/test/项目 B/同名.md'));
 await native.getByRole('button',{name:'新建文档',exact:true}).click();
 await native.waitForFunction(()=>nativeCalls.some(c=>c.command==='open_document'&&c.args.path==='/Users/test/新建.md'));
 assert.ok(await native.evaluate(()=>nativeCalls.some(c=>c.command==='new_document'&&c.args.path==='/Users/test/新建.md')));
 assert.equal(await native.locator('#welcomeScreen').isVisible(),true,'native new must open a real document window, not turn the welcome buffer into an unsavable document');
 assert.equal(await native.locator('.welcome-actions button').count(),3);
 assert.deepEqual(errors,[]);
 console.log('PASS welcome layout, recent tooltip/popover, narrow/dark, new document and file drop');
}finally{await browser.close()}
