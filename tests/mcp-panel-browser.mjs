import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium,launchOptions} from './browser-runtime.mjs';
const html=await readFile(new URL('../dist/mcp-reader.html',import.meta.url),'utf8');
const base=process.env.LEAF_TEST_BASE_URL||'http://127.0.0.1:41732';
const browser=await chromium.launch(launchOptions);
try{
 await test('real SDK simulated browser host renders structures, comments and two read-only revisions',async()=>{
  const page=await browser.newPage({viewport:{width:600,height:900}}),errors=[],external=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('untrusted.invalid'))external.push(r.url());});
  await page.goto(`${base}/tests/mcp-panel-host.html`);
  await page.waitForFunction(()=>typeof setupReaderHost==='function');await page.waitForLoadState('networkidle');
  await page.evaluate(html=>setupReaderHost(html),html);
  const panel=page.frameLocator('#panel');await panel.locator('#status').filter({hasText:'Current draft'}).waitFor();
  assert.match(await panel.locator('#identity').innerText(),/Revision 1/);
  assert.doesNotMatch(await panel.locator('#identity').innerText(),/CRLF|UTF-16/);
  assert.equal(await panel.locator('#sourceMetadata').textContent(),'CRLF · UTF-16');
  assert.match(await panel.locator('.print-properties').innerText(),/Reader/);
  assert.equal(await panel.locator('#reader table').count(),1);
  assert.match(await panel.locator('#reader').innerText(),/Footnote/);
  assert.equal(await panel.locator('.comment-card').count(),3);
  await panel.locator('.comment-card[data-kind=hidden] button').click();assert.equal(await panel.locator('.located').count(),1);
  assert.equal(await panel.locator('[contenteditable],textarea,input').count(),0);
  assert.equal(await panel.locator('#reader script').count(),0);assert.equal(await panel.locator('#reader img').count(),0);
  await page.evaluate(()=>{readerCurrent=readerValue(2);});
  assert.equal(await panel.locator('#refresh').isEnabled(),true,JSON.stringify({status:await panel.locator('#status').innerText(),calls:await page.evaluate(()=>readerCalls.map(call=>call.name)),errors}));
  await panel.locator('#refresh').click();
  await panel.locator('#identity').filter({hasText:'Revision 2'}).waitFor();assert.match(await panel.locator('#diff').innerText(),/updated/);
  // Duplicate and late replies retain both the latest text and the single diff.
  const diff=await panel.locator('#diff').innerText();await panel.locator('#refresh').click();assert.equal(await panel.locator('#diff').innerText(),diff);
  await page.evaluate(()=>{readerCurrent=readerValue(1);});await panel.locator('#refresh').click();assert.match(await panel.locator('#identity').innerText(),/Revision 2/);
  for(const locale of ['zh-Hans','zh-Hant-TW','en'])for(const theme of ['light','dark']){
   await page.evaluate(({locale,theme})=>readerHost.setHostContext({locale,theme}),{locale,theme});
   await page.setViewportSize({width:320,height:900});
   await panel.locator(`html[lang="${locale}"][data-theme="${theme}"]`).waitFor();
   assert.equal(await panel.locator('body').evaluate(e=>e.scrollWidth<=e.ownerDocument.documentElement.clientWidth),true,`${locale} ${theme} narrow`);
   assert.equal(await panel.locator('#refresh').isVisible(),true);
   const expected={
    'zh-Hans':{revision:'修订号 2',reader:'文档',source:'Markdown 源码'},
    'zh-Hant-TW':{revision:'修訂編號 2',reader:'文件',source:'Markdown 原始碼'},
    en:{revision:'Revision 2',reader:'Document',source:'Markdown source'},
   }[locale];
   assert.match(await panel.locator('#identity').innerText(),new RegExp(expected.revision));
   assert.equal(await panel.locator('#reader').getAttribute('aria-label'),expected.reader);
   assert.equal(await panel.locator('#sourceTitle').innerText(),expected.source);

   await mkdir(new URL('../test-results/mcp-panel/',import.meta.url),{recursive:true});await page.screenshot({path:`test-results/mcp-panel/${locale}-${theme}.png`});
  }
  await page.evaluate(()=>{readerCurrent=readerValue(3);readerCurrent.snapshot.content='# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\n**Bold** and *italic*\n\n> [!note]\n> A note.';});
  await panel.locator('#refresh').click();await panel.locator('#identity').filter({hasText:'Revision 3'}).waitFor();
  const typography=await panel.locator('#reader').evaluate(root=>({
    headings:[...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(n=>({size:parseFloat(getComputedStyle(n).fontSize),weight:getComputedStyle(n).fontWeight,color:getComputedStyle(n).color})),
    body:parseFloat(getComputedStyle(root).fontSize),callout:!!root.querySelector('.leaf-callout'),
  }));
  assert.equal(typography.headings.length,6);assert.ok(typography.headings.slice(3).every(h=>h.size>typography.body&&h.weight==='600'));
  assert.equal(new Set(typography.headings.map(h=>h.color)).size,6);assert.equal(typography.callout,true);
  await page.evaluate(()=>{readerCurrent=readerValue(4);});await panel.locator('#stop').click();await panel.locator('#stop:disabled').waitFor();
  assert.ok(await page.evaluate(()=>readerCalls.some(c=>c.name==='stop_edit'&&c.args.task_id==='synthetic-task')));
  await page.evaluate(()=>{readerDenied=true;});await panel.locator('#refresh').click();await panel.locator('#refresh:disabled').waitFor();
  assert.equal(await panel.locator('#reader').innerText(),'');assert.equal(await panel.locator('#source').innerText(),'');assert.equal(await panel.locator('.comment-card').count(),0);
  await page.evaluate(()=>{readerDenied=false;readerHost.sendToolResult({content:[],structuredContent:readerValue(2)});});
  await page.waitForTimeout(30);assert.equal(await panel.locator('#reader').innerText(),'');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await page.close();
 });
 await test('browser fallback is continuously labeled and clears on disconnect',async()=>{
  const page=await browser.newPage({viewport:{width:320,height:800}});
  const binding={document_id:'synthetic-document',session_id:'synthetic-session',authorization_epoch:1};let connected=true;
  await page.route('**/reader',r=>r.fulfill({contentType:'text/html',body:html}));
  await page.route('**/reader-auth',r=>r.fulfill({json:{authenticated:true}}));
  await page.route('**/reader-api',r=>connected?r.fulfill({json:{binding,snapshot:{content:'# Unsaved fallback',revision:1,name:'Synthetic.md',language:'zh-Hans',saved:false,line_ending:'\r\n'},comments:[],task:null}}):r.fulfill({status:401}));
  await page.goto(`${base}/reader#synthetic-one-use-ticket`);
  await page.locator('#viewKind').filter({hasText:'浏览器实时视图'}).waitFor();assert.equal(new URL(page.url()).hash,'');
  assert.match(await page.locator('#reader').innerText(),/Unsaved fallback/);connected=false;await page.locator('#refresh').click();await page.locator('#refresh:disabled').waitFor();
  assert.equal(await page.locator('#reader').innerText(),'');assert.equal(await page.locator('#viewKind').innerText(),'浏览器实时视图');await page.close();
 });
}finally{await browser.close();}
