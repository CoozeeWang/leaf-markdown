import assert from 'node:assert/strict';
import {chromium, webkit} from 'playwright';

// Synthetic public sample: real document widgets, no private files or AI calls.
const refs = Array.from({length:100}, (_, i) => `[^n${i + 1}]`).join(' ');
const source = `---\ntitle: Geometry sample\ntags: [sample]\n---\n\nBody ${refs}\n\n${Array.from({length:100}, (_, i) => `[^n${i + 1}]: Note ${i + 1}.`).join('\n\n')}\n\n[^long-unreferenced-label]: Orphan note.`;
const engine = process.env.LEAF_TEST_ENGINE === 'webkit' ? webkit : chromium;
const browser = await engine.launch({headless:true});
let scenarios = 0;
try {
 for (const locale of ['zh-CN','zh-TW','en-US']) {
  const page = await browser.newPage({locale, viewport:{width:1100,height:800}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:41732');
  await page.click('#welcomeNewButton');
  await page.evaluate(async source=>{
   const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
   window.v=EditorView.findFromDOM(document.querySelector('#editor .cm-content'));
   v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source},selection:{anchor:source.indexOf('Body')}});
  },source);
  const fold=page.locator('.leaf-property-fold');
  await fold.waitFor();
  for (const theme of ['light','dark']) for (const font of [17,20,28]) for (const zoom of [50,100,200]) {
   await page.evaluate(({theme,font,zoom})=>{
    document.documentElement.dataset.theme=theme;
    const shell=document.querySelector('.shell');
    shell.style.setProperty('--editor-font-size',`${font}px`);
    shell.style.setProperty('--body-zoom',String(zoom/100));
    v.requestMeasure();
   },{theme,font,zoom});
   await page.evaluate(()=>document.fonts.ready);
   await page.evaluate(()=>new Promise(resolve=>v.requestMeasure({read:()=>null,write:()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))})));
   await page.evaluate(()=>v.dispatch({selection:{anchor:v.state.doc.toString().indexOf('Body')},scrollIntoView:true}));
   await fold.waitFor();
   for (const expanded of [true,false]) {
    assert.equal(await fold.getAttribute('aria-expanded'),String(expanded));
    for (const state of ['hover','focus']) {
     if(state==='hover'){await fold.hover();await page.waitForFunction(()=>getComputedStyle(document.querySelector('.leaf-property-fold')).backgroundColor!=='rgba(0, 0, 0, 0)');}
     else {await page.mouse.move(0,0);await page.locator('#commandsButton').focus();await page.keyboard.press('Tab');await fold.focus();}
     const result=await fold.evaluate(button=>{
      const b=button.getBoundingClientRect(),svg=button.querySelector('svg'),s=svg.getBoundingClientRect(),p=svg.querySelector('path').getBBox();
      return {dx:(s.left+s.right-b.left-b.right)/2,dy:(s.top+s.bottom-b.top-b.bottom)/2,pathX:p.x+p.width/2,pathY:p.y+p.height/2,background:getComputedStyle(button).backgroundColor,focused:button===document.activeElement,outline:getComputedStyle(button).outlineStyle};
     });
     assert.ok(Math.abs(result.dx)<.15&&Math.abs(result.dy)<.15,JSON.stringify({theme,font,zoom,state,result}));
     assert.equal(result.pathX,12);assert.equal(result.pathY,12);
     if(state==='hover')assert.notEqual(result.background,'rgba(0, 0, 0, 0)');
     else {assert.ok(result.focused,JSON.stringify({locale,theme,font,zoom,expanded,result,active:await page.evaluate(()=>document.activeElement?.outerHTML.slice(0,180))}));assert.equal(result.outline,'solid');}
    }
    // Keyboard activation must preserve focus when CodeMirror replaces the widget.
    await fold.press(expanded?'Enter':'Space');
    await page.waitForFunction(expanded=>document.querySelector('.leaf-property-fold')?.getAttribute('aria-expanded')===String(!expanded),expanded);
    assert.ok(await fold.evaluate(button=>button===document.activeElement));
    assert.equal(await page.locator('.leaf-property-body').evaluate(body=>body.hidden),expanded);
   }
   await page.evaluate(()=>{const scroller=document.querySelector('#editor .cm-scroller');scroller.scrollTop=scroller.scrollHeight;});
   await page.locator('.leaf-endnote-number').first().waitFor();
   const numbers=await page.locator('.leaf-endnote-number').evaluateAll(nodes=>nodes.map(node=>{
    const r=node.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(node);const t=range.getBoundingClientRect();
    return {label:node.textContent,w:r.width,h:r.height,dx:(t.left+t.right-r.left-r.right)/2,textWidth:t.width};
   }));
   for(const label of ['1','9','10','99']){
    const n=numbers.find(n=>n.label===label);assert.ok(n,`missing ${label}: ${JSON.stringify(numbers.slice(0,12))}`);
    assert.ok(Math.abs(n.w-n.h)<.2,JSON.stringify({theme,font,zoom,n}));
    assert.ok(Math.abs(n.dx)<.2);assert.ok(n.textWidth<=n.w);
   }
   for(const label of ['100','[long-unreferenced-label]']){
    const n=numbers.find(n=>n.label===label);assert.ok(n);assert.ok(n.textWidth<=n.w);assert.ok(Math.abs(n.dx)<.2);
   }
   assert.equal(await page.evaluate(()=>v.state.doc.toString()),source,'display changes preserve all YAML and notes');
   scenarios++;
  }
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log(`PASS ${engine.name()}: ${scenarios} geometry scenarios; 3 languages, light/dark, 17/20/28px, 50/100/200%; expanded/collapsed, hover/focus, keyboard activation, notes 1/9/10/99/100/long label, source preserved`);
} finally {await browser.close();}
