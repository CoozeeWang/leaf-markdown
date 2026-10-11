import assert from 'node:assert/strict';
import {webkit} from 'playwright';
import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
const source='# Sample\n\nFirst  \nSecond\\\nThird<br>Fourth\n\n\\*literal\\* and \\_text\\_ and \\[label\\] and \\# sign.\n\n`\\*code\\*` and \\a unchanged.\n\n**Bold  \nnext**\n\nSoft\nline.';
for(const engine of ['chrome','webkit']) {
 const browser=await(engine==='webkit'?webkit.launch({headless:true}):chromium.launch(launchOptions));
 try {
  const page=await browser.newPage();
  await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
  await page.locator('.cm-content').fill(source);
  await page.click('#readingToggle');await page.click('[data-mode="reading"]');
  const verify=async root=>{
   const p=root.locator('p');
   assert.equal(await p.nth(0).locator('br').count(),3);
   assert.match(await p.nth(0).innerText(),/First\nSecond\nThird\nFourth/);
   assert.equal(await p.nth(1).textContent(),'*literal* and _text_ and [label] and # sign.');
   assert.equal(await p.nth(1).locator('em,a').count(),0);
   assert.equal(await p.nth(2).locator('code').textContent(),'\\*code\\*');
   assert.match(await p.nth(2).textContent(),/\\a unchanged/);
   assert.equal(await p.nth(3).locator('strong br').count(),1);
   assert.equal(await p.nth(4).locator('br').count(),0);
  };
  await verify(page.locator('.reading-document'));
  await page.evaluate(source=>sessionStorage.setItem('render-regression',JSON.stringify({source,name:'Sample.md',numbered:false})),source);
  await page.goto('http://127.0.0.1:41732/?export=render-regression');await page.locator('.print-document h1').waitFor();
  await verify(page.locator('.print-document'));
  await page.evaluate(async()=>{
   const r=await import('/src/resources.js');window.r=r;
   r.setResourceRevealer(async()=>{});r.setResourceReader(async()=>{throw Error('ENOENT');});
   document.querySelector('.print-document').append(r.imageNode('Sample','assets/sample.png'));
   await r.waitForImages(document.querySelector('.print-document')).catch(()=>{});
  });
  await page.locator('img[data-loaded="error"]').waitFor({state:'attached'});
  assert.equal(await page.locator('.leaf-image-status[data-kind][role="button"]').count(),1);
  await page.evaluate(async()=>{
   const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
   r.setResourceReader(async()=>Array.from(atob(png),c=>c.charCodeAt(0)));
   await r.waitForImages(document.querySelector('.print-document'));
   (await import('/src/i18n.js')).refreshTranslations();
  });
  assert.equal(await page.locator('img[data-loaded="yes"]').count(),1);
  assert.equal(await page.locator('.leaf-image-status[data-kind],.leaf-image-status[tabindex],.leaf-image-status[role]').count(),0);
  assert.equal(await page.locator('.leaf-image-status').textContent(),'');
  assert.equal(await page.locator('.leaf-image-status').evaluate(e=>e.getBoundingClientRect().height),0);
  await page.screenshot({path:artifactPath(`markdown-render-recovery-${engine}.png`)});
  await page.emulateMedia({media:'print'});await verify(page.locator('.print-document'));
  console.log(`PASS ${engine}: hard breaks, escapes, literal code, reading/PDF and image retry cleanup after translation refresh`);
 }finally{await browser.close();}
}
