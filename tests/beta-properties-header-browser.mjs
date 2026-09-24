import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:900,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'# 正文\n\n保留内容'}});});
 const add=async()=>{await page.click('#commandsButton');await page.fill('#paletteInput','文档属性');await page.getByRole('option',{name:'文档属性',exact:true}).click();await page.getByLabel('新属性名',{exact:true}).waitFor();};
 const source=()=>page.evaluate(()=>v.state.doc.toString());
 await add();await page.getByLabel('新属性名',{exact:true}).fill('作者');await page.getByLabel('新属性值',{exact:true}).fill('小叶');
 await page.getByLabel('新属性值',{exact:true}).press('Enter');
 assert.ok((await source()).includes('"作者": "小叶"'));assert.equal(await page.locator('.leaf-property-add').count(),0);
 await page.getByRole('button',{name:'添加文档属性',exact:true}).click();
 await page.getByLabel('新属性名',{exact:true}).fill('状态');await page.getByLabel('新属性值',{exact:true}).fill('草稿');
 await page.getByLabel('新属性值',{exact:true}).evaluate(e=>e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true})));
 assert.equal(await page.locator('.leaf-property-add').count(),1,'IME Enter does not submit');
 await page.getByLabel('新属性值',{exact:true}).press('Enter');assert.ok((await source()).includes('"状态": "草稿"'));
 await page.getByRole('button',{name:'添加文档属性',exact:true}).click();await page.locator('.brand').click();
 await page.waitForFunction(()=>!document.querySelector('.leaf-property-add'));
 assert.ok((await source()).includes('"作者"'),'abandoning empty row preserves existing fields');
 await page.evaluate(()=>v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'# 正文\n\n保留内容'},selection:{anchor:0}}));
 await add();await page.locator('.brand').click();await page.waitForFunction(()=>!v.state.doc.toString().startsWith('---'));
 assert.equal(await source(),'# 正文\n\n保留内容');assert.equal(await page.locator('.leaf-yaml').count(),0);
 await add();await page.getByLabel('新属性值',{exact:true}).press('Enter');assert.equal(await source(),'# 正文\n\n保留内容');
 for(const width of [900,1000,1100,1500]) {
  await page.setViewportSize({width,height:800});
  for(const desktop of [false,true]) {
   await page.evaluate(desktop=>{document.querySelector('#recentButton').hidden=desktop;document.querySelector('#fileName').textContent='使用反馈_0.4-beta-这是一篇很长的文件名.md';},desktop);
   const m=await page.evaluate(()=>{
    const b=s=>document.querySelector(s).getBoundingClientRect();const center=b('.document-primary'),brand=b('.brand'),actions=b('.topbar-actions'),small=b('.brand-copy small');
    return {offset:Math.abs((center.left+center.right)/2-innerWidth/2),gapLeft:center.left-brand.right,gapRight:actions.left-center.right,tagline:small.width>0&&small.height>0};
   });
   assert.ok(m.offset<1,JSON.stringify({width,desktop,...m}));assert.ok(m.gapLeft>=8&&m.gapRight>=8,JSON.stringify(m));assert.ok(m.tagline);
  }
  if(width===900)for(const theme of ['light','dark']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.screenshot({path:artifactPath(`leaf-beta-header-${theme}-900.png`)});}
 }
 assert.deepEqual(errors,[]);console.log('PASS Return commit, IME guard, abandoned empty properties, centered header and visible branding at 900–1500px');
}finally{await browser.close();}
