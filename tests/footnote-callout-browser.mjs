import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
  const page=await browser.newPage({viewport:{width:1200,height:900},deviceScaleFactor:2}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:41732');
  await page.click('#welcomeNewButton');
  await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});

  const doc=()=>page.evaluate(()=>v.state.doc.toString());
  const setDoc=text=>page.evaluate(t=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:t}});},text);
  const widgetCount=()=>page.locator('.leaf-callout-widget').count();
  const preview=field=>page.evaluate(f=>document.querySelector(`.leaf-callout-widget .leaf-callout-${f} .leaf-callout-preview`)?.innerHTML,field);
  const box=field=>page.evaluate(f=>{
    const t=document.querySelector(`.leaf-callout-widget .leaf-callout-${f} textarea`);
    return t?{value:t.value,start:t.selectionStart,end:t.selectionEnd,focused:document.activeElement===t,editing:!!t.closest('.is-editing'),visible:t.offsetParent!==null}:null;
  },field);
  // Clicking a callout's rendering is how a writer gets into it: the rendering is
  // replaced by the box, which takes the caret. A box already in front of the
  // rendering -- because the caret was left in it -- is clicked past, not found.
  const enter=async(field,offset)=>{
    const open=await page.evaluate(f=>{const t=document.querySelector(`.leaf-callout-widget .leaf-callout-${f} textarea`);return !!t&&t.offsetParent!==null;},field);
    if(!open) await page.click(`.leaf-callout-widget .leaf-callout-${field} .leaf-callout-preview`,{position:{x:24,y:8}});
    await page.evaluate(([f,n])=>{const t=document.querySelector(`.leaf-callout-widget .leaf-callout-${f} textarea`);t.focus();t.setSelectionRange(n,n);},[field,offset]);
    await page.waitForTimeout(80);
  };
  const button=page.locator('[data-format="footnote"]');
  // The box takes the caret in a frame of its own, so typing before it does lands
  // nowhere. Wait for the caret rather than for a number of milliseconds.
  const boxFocused=()=>page.waitForFunction(()=>!!document.activeElement?.closest?.('.footnote-box'));

  // 1. A hand-typed citation inside a callout reads as the number the reader will
  //    see: the callout draws its own preview from a text area, so the citation
  //    pass never walks it and the numbers have to be handed in.
  await setDoc('# 标题\n\n> [!note] 口径\n> 数据来自公开报道[^a]，未经独立核实。\n\n[^a]: 第一条。\n');
  await page.waitForTimeout(250);
  assert.equal(await preview('body'),'<p>数据来自公开报道<sup class="footnote-ref">1</sup>，未经独立核实。</p>','callout 里手打的引用要读作编号');

  // 2. The toolbar button writes the marker where the caret is -- inside the
  //    callout -- instead of where the document selection happened to be left.
  await enter('body',6);
  await button.click();
  assert.equal(await doc(),'# 标题\n\n> [!note] 口径\n> 数据来自公开[^1]报道[^a]，未经独立核实。\n\n[^1]:\n[^a]: 第一条。\n','标记要落在 callout 里光标的位置，定义排到它前面那条之前');
  assert.equal(await page.locator('.footnote-box').count(),1,'插入后浮出注释输入框');
  await boxFocused();
  await page.keyboard.type('报道的规模');
  await page.waitForTimeout(150);
  assert.equal(await doc(),'# 标题\n\n> [!note] 口径\n> 数据来自公开[^1]报道[^a]，未经独立核实。\n\n[^1]: 报道的规模\n[^a]: 第一条。\n','浮框里写的字要落进定义');
  assert.equal(await preview('body'),'<p>数据来自公开<sup class="footnote-ref">1</sup>报道<sup class="footnote-ref">2</sup>，未经独立核实。</p>','新注释是 1，原来那条被推成 2');

  // 3. Closing the box gives the caret back to the callout, on the marker it just
  //    wrote -- the whole point of aiming the insert at the box.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  assert.deepEqual(await box('body'),{value:'数据来自公开[^1]报道[^a]，未经独立核实。',start:10,end:10,focused:true,editing:true,visible:true},'Esc 之后光标回到标记之后');
  assert.equal(await page.locator('.footnote-box').count(),0);

  // 4. What the editor writes is what the reader sees, callout and all.
  await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
  assert.deepEqual(await page.locator('.reading-document .footnote-ref').allTextContents(),['1','2'],'阅读视图的编号要与 callout 里的一致');
  await page.locator('.reading-document').screenshot({path:artifactPath('leaf-callout-footnote.png')});
  await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();

  // 5. A note inserted between two numbered citations renumbers them in place, and
  //    the whole thing is one step: the marker moved and the definitions moved with
  //    it. Undo has to take both back at once.
  await setDoc('> [!tip] 提示\n> 甲[^1] 乙[^2]\n\n[^1]: A\n[^2]: B\n');
  await page.waitForTimeout(250);
  await enter('body','甲[^1] '.length);
  await button.click();
  assert.equal(await doc(),'> [!tip] 提示\n> 甲[^1] [^2]乙[^3]\n\n[^1]: A\n[^2]:\n[^3]: B\n','callout 里的数字标记也要重排');
  assert.equal(await preview('body'),'<p>甲<sup class="footnote-ref">1</sup> <sup class="footnote-ref">2</sup>乙<sup class="footnote-ref">3</sup></p>');
  await page.click('#undoButton');
  assert.equal(await doc(),'> [!tip] 提示\n> 甲[^1] 乙[^2]\n\n[^1]: A\n[^2]: B\n','一次撤销要把标记和定义一起回退');

  // 6. A callout the toolbar has just made has no title and no space after the
  //    "[!note]": the marker would read as part of the type and the block would
  //    stop being a callout, so the insert writes that space too.
  await setDoc('> [!note]\n> 内容。\n\n[^1]: 已有的\n');
  await page.waitForTimeout(250);
  await enter('title',0);
  await button.click();
  await page.waitForTimeout(150);
  assert.equal(await doc(),'> [!note] [^2]\n> 内容。\n\n[^1]: 已有的\n\n[^2]:','空标题前要补上那个空格');
  assert.equal(await widgetCount(),1,'插了标记之后这个块仍然是个提示块');
  assert.equal(await preview('title'),'<sup class="footnote-ref">1</sup>','标题里的引用也读作编号');

  // 7. The shortcut reaches the box as well. A widget takes its own events, which
  //    is what keeps Enter and Backspace meaning what they mean in a text area, so
  //    this one is carried past that by hand.
  await setDoc('> [!note] 口径\n> 数据[^a]。\n\n[^a]: 甲\n');
  await page.waitForTimeout(250);
  await enter('body',2);
  await page.keyboard.press('ControlOrMeta+Shift+f');
  await boxFocused();
  await page.keyboard.press('Escape');
  assert.equal(await doc(),'> [!note] 口径\n> 数据[^1][^a]。\n\n[^1]:\n[^a]: 甲\n','快捷键也要落在 callout 里');

  // 8. The caret decides, and it decides both ways: once the writer is back in the
  //    document the marker goes back to the document, so the callout is not where
  //    every later note lands.
  await setDoc('> [!note] 口径\n> 数据[^a]。\n\n正文[^b]。\n\n[^a]: 甲\n[^b]: 乙\n');
  await page.waitForTimeout(250);
  await enter('body',2);
  await button.click();
  await boxFocused();
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{const line=v.state.doc.line(4);v.dispatch({selection:{anchor:line.to}});v.focus();});
  await page.waitForTimeout(80);
  await button.click();
  await page.waitForTimeout(200);
  // The callout keeps the note written into it, the second one goes where the caret
  // now is -- the end of the fourth line -- and being the last citation in the
  // document it takes the last number and the last place among the definitions.
  assert.equal(await doc(),'> [!note] 口径\n> 数据[^1][^a]。\n\n正文[^b]。[^4]\n\n[^1]:\n[^a]: 甲\n[^b]: 乙\n\n[^4]:','光标回到正文后，标记要落回正文');
  await page.keyboard.press('Escape');

  assert.deepEqual(errors,[]);
  console.log('PASS callout 里的脚注：编号渲染、插入落在输入框、光标回位、一次撤销、空标题补空格、快捷键');
} finally { await browser.close(); }
