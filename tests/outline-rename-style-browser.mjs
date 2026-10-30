import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {launchOptions,artifactPath} from './browser-runtime.mjs';
for(const [name,engine] of Object.entries({chromium,webkit}).filter(([name])=>!process.env.LEAF_RENAME_ENGINE||process.env.LEAF_RENAME_ENGINE===name)){
 const browser=await engine.launch(name==='chromium'?launchOptions:{headless:true});
 try {
  const page=await browser.newPage({locale:'zh-CN',viewport:{width:1100,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
  const source=Array.from({length:6},(_,i)=>`${'#'.repeat(i+1)} ${i+1} 原地标题 ${'中文长标题 mixed text '.repeat(6)}\n\n正文 ${i+1}\n\n`).join('');
  await page.evaluate(async source=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source}});},source);
  await page.click('#outlineButton');
  const read=()=>page.evaluate(()=>v.state.doc.toString());
  const metrics=element=>{
   const s=getComputedStyle(element),r=element.getBoundingClientRect();
   return {font:s.fontFamily,size:s.fontSize,weight:s.fontWeight,line:s.lineHeight,spacing:s.letterSpacing,color:s.color,x:r.x,y:r.y,width:r.width,height:r.height,padding:[s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft]};
  };
  for(const theme of ['light','dark'])for(const width of [1100,760]){
   await page.setViewportSize({width,height:800});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   if(!await page.locator('.outline-item').first().isVisible())await page.click('#outlineButton');
   for(let level=1;level<=6;level++){
    const heading=page.locator(`.outline-item[data-level="${level}"]`);
    await heading.click();await heading.hover();await heading.evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));const before=await heading.evaluate(metrics);
    await heading.dblclick();const input=page.locator('.outline-rename');await input.waitFor();await page.waitForFunction(()=>document.querySelector('.outline-rename')?.scrollLeft===0);
    assert.deepEqual(await input.evaluate(metrics),before,`${name}/${theme}/${width}/H${level}: text and row metrics unchanged`);
    assert.deepEqual(await input.evaluate(e=>{const s=getComputedStyle(e);return {border:s.borderWidth,radius:s.borderRadius,bg:s.backgroundColor,outline:s.outlineStyle};}),{border:'0px',radius:'0px',bg:'rgba(0, 0, 0, 0)',outline:'none'});
    assert.match(await input.evaluate(e=>getComputedStyle(e).boxShadow),/inset/,'underline is the accessible focus indication');
    assert.deepEqual(await input.evaluate(e=>[e.selectionStart,e.selectionEnd]),[0,(await input.inputValue()).length]);
    await input.dispatchEvent('keydown',{key:'Enter',isComposing:true});assert.equal(await input.count(),1,'IME candidate Enter does not confirm');
    if(level===3&&theme==='dark'&&width===760)await page.screenshot({path:artifactPath(`outline-rename-${name}.png`)});
    await input.fill('取消修改');await input.press('Escape');assert.equal(await read(),source);
   }
  }
  const first=page.locator('.outline-item').first();await first.dblclick();await page.locator('.outline-rename').fill('新的合成标题');await page.locator('.outline-rename').press('Enter');assert.ok((await read()).startsWith('# 新的合成标题\n'));
  await page.click('#undoButton');assert.equal(await read(),source,'rename remains a document history action');
  await first.dblclick();await page.locator('.outline-rename').fill('失焦提交');await page.locator('#headingButton').focus();assert.ok((await read()).startsWith('# 失焦提交\n'));await page.click('#undoButton');assert.equal(await read(),source);
  assert.deepEqual(errors,[]);console.log(`PASS ${name}: H1–H6, light/dark, narrow, exact label/input metrics, underline only, select-all, IME Enter guard, Esc, Enter, blur and undo`);
 }finally{await browser.close();}
}
