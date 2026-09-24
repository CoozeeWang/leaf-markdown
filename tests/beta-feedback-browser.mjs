import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.click('#displayButton');await page.check('#lineNumberToggle');await page.click('#displayButton');
 await page.evaluate(async()=>{
  const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
  window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));
  const {setResourceReader}=await import('/src/resources.js');
  const canvas=document.createElement('canvas');canvas.width=600;canvas.height=200;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#c6d7c2';ctx.fillRect(0,0,600,200);
  const blob=await new Promise(r=>canvas.toBlob(r));const bytes=[...new Uint8Array(await blob.arrayBuffer())];
  window.loads=0;setResourceReader(async()=>{loads++;return bytes;});
  v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'正文输入\n\n![图片](反馈.assets/photo.png)\n\n后面的正文'},selection:{anchor:4}});
 });
 await page.waitForSelector('img[data-loaded="yes"]');
 await page.waitForTimeout(150);
 await page.evaluate(()=>{window.gutterSamples=[];window.sampling=true;const sample=()=>{gutterSamples.push([...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].filter(e=>e.textContent==='1').map(e=>e.getBoundingClientRect().top+parseFloat(e.style.paddingTop||0))[0]);if(sampling)requestAnimationFrame(sample);};sample();});
 await page.evaluate(()=>{window.originalImage=document.querySelector('.cm-content img[data-resource]');window.startLoads=loads;});
 await page.locator('.cm-content').focus();await page.keyboard.type('abcdefghijk',{delay:35});
 assert.ok(await page.evaluate(()=>originalImage===document.querySelector('.cm-content img[data-resource]')),'typing before image retains its DOM');
 assert.equal(await page.evaluate(()=>loads),await page.evaluate(()=>startLoads),'no image reload on typing');
 const jitter=await page.evaluate(()=>{sampling=false;const a=gutterSamples.filter(Number.isFinite);return Math.max(...a)-Math.min(...a);});assert.ok(jitter<2,`line number jitter ${jitter}: ${JSON.stringify(await page.evaluate(()=>gutterSamples))}`);
 await page.locator('.cm-content img[data-resource]').click();
 assert.ok(await page.evaluate(()=>v.state.doc.lineAt(v.state.selection.main.head).text.includes('![')),'image click uses updated source offset');
 await page.evaluate(()=>{const text='---\ntitle: test\n---\n\n正文';v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:text.length}});});
 await page.getByRole('button',{name:'添加文档属性',exact:true}).click();
 assert.ok(await page.evaluate(()=>{const form=document.querySelector('.leaf-property-add'),button=document.querySelector('.leaf-property-add-button');return form.getBoundingClientRect().bottom<=button.getBoundingClientRect().top;}));
 await page.getByLabel('新属性名',{exact:true}).fill('author');await page.getByLabel('新属性值',{exact:true}).fill('Leaf');await page.getByLabel('新属性名',{exact:true}).press('Enter');
 await page.evaluate(async()=>{
  const {frontmatter}=await import('/src/markdown-model.js');const yaml=frontmatter(v.state.doc.toString());
  v.dispatch({selection:{anchor:0,head:yaml.to}});v.focus();
 });
 await page.keyboard.press('Backspace');
 assert.equal(await page.evaluate(()=>v.state.doc.toString()),'正文','whole property deletion removes separator blanks');
 await page.keyboard.press('Meta+z');assert.match(await page.evaluate(()=>v.state.doc.toString()),/^---\n/);
 await page.evaluate(()=>v.dispatch({selection:{anchor:v.state.doc.length}}));
 await page.getByRole('button',{name:'编辑此块 Markdown 源码',exact:true}).click();
 await page.getByLabel('文档属性源码',{exact:true}).fill('');
 assert.equal(await page.evaluate(()=>v.state.doc.toString()),'正文','clearing properties source also removes separator blanks');
 assert.equal(await page.locator('.leaf-property-source').count(),0,'no empty properties editor survives deletion');
 await page.evaluate(()=>{const text='## 标题\n\n正文第一行，自动折行仍使用普通行距。\n正文第二行\n\n![图片](反馈.assets/photo.png)\n\n| 名称 | 值 |\n| --- | --- |\n| 示例 | 内容 |\n\n后面的正文';v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:0}});});
 await page.waitForSelector('img[data-loaded="yes"]');
 await page.screenshot({path:artifactPath('leaf-beta-feedback.png')});
 for(const theme of ['light','dark']) {
  for(const width of [1100,720]) {
   await page.setViewportSize({width,height:800});
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   await page.screenshot({path:artifactPath(`leaf-beta-feedback-${theme}-${width}.png`)});
  }
 }
 assert.deepEqual(errors,[]);console.log('PASS beta feedback: stable add button, image reuse and click offset, clean property deletion and undo');
} finally {await browser.close();}
