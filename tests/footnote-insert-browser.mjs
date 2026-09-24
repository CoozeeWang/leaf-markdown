import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 for (const platform of ['MacIntel', 'Win32']) {
  const page=await browser.newPage({viewport:{width:1200,height:900},deviceScaleFactor:2}),errors=[];
  await page.addInitScript(p => {
    Object.defineProperty(navigator, 'platform', { get: () => p });
    Object.defineProperty(navigator, 'userAgentData', { get: () => undefined });
  }, platform);
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:41732');
  await page.click('#welcomeNewButton');
  await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});
  const doc=()=>page.evaluate(()=>v.state.doc.toString());
  const caret=()=>page.evaluate(()=>v.state.selection.main.head);
  const lines=()=>page.evaluate(()=>[...document.querySelectorAll('.cm-content .cm-line')].map(l=>l.textContent));
  const setDoc=text=>page.evaluate(t=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:t}});},text);
  const putCaret=async({anchor,head=anchor})=>page.evaluate(s=>{v.dispatch({selection:{anchor:s.anchor,head:s.head}});v.focus();},{anchor,head});
  const box=page.locator('.footnote-box textarea');
  const editorsFocus=()=>page.evaluate(()=>document.activeElement.classList.contains('cm-content'));

  // The toolbar button carries the shortcut through the shared platform path,
  // so the label reads Shift-Cmd-F here and Ctrl-Shift-F on Windows.
  const button=page.locator('[data-format="footnote"]');
  assert.equal(await button.count(),1,'工具栏应有插入脚注按钮');
  assert.equal(await button.getAttribute('aria-label'),'插入脚注');
  const footnoteShortcut = platform === 'MacIntel' ? '⇧⌘F' : 'Ctrl+Shift+F';
  assert.equal(await button.getAttribute('data-tooltip'),`插入脚注  ${footnoteShortcut}`);
  assert.equal(await button.locator('svg.ui-icon path').count()>0,true,'按钮要有矢量图标');

  // 1. A bare insert with the caret inside the body: marker in place, definition
  //    written between the definitions around it, and the numbers after the
  //    insertion point move down.
  await setDoc('甲[^1] 乙[^2]\n\n[^1]: A\n[^2]: B\n');
  await putCaret({anchor:1});
  await button.click();
  assert.equal(await doc(),'甲[^1][^2] 乙[^3]\n\n[^1]:\n[^2]: A\n[^3]: B\n','标号要重排成与页面一致，新定义要落在两条定义中间');
  assert.equal(await caret(),5,'光标要停在标记后面，不再跑到文末');
  const readback=await lines();
  assert.equal(readback[2].startsWith('[1]'),true,'新定义要排在第一条定义的位置上');
  assert.equal(readback[3],'[2] A','原来第一条定义被推到后面，编号跟着变');

  // 2. The note is written where it is read: a box under the marker, focused and
  //    empty, instead of a caret parked in the definition at the end of the file.
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.footnote-box').count(),1,'插入后应浮出注释输入框');
  assert.equal(await page.evaluate(()=>document.activeElement.tagName),'TEXTAREA','输入框要拿到焦点');
  assert.equal(await box.inputValue(),'','新注释的输入框应为空');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.footnote-box').count(),0,'Esc 要关掉输入框');
  assert.equal(await editorsFocus(),true,'关掉后焦点要回到编辑器');

  // 3. One Cmd-Z puts all of it back: the marker, the definition and the renames
  //    were dispatched as a single transaction.
  await page.click('#undoButton');
  assert.equal(await doc(),'甲[^1] 乙[^2]\n\n[^1]: A\n[^2]: B\n','一次撤销要整体回退');

  // 4. A selection moves into the note, the caret stays in the sentence, and the
  //    box opens holding the words that were carried away.
  await setDoc('他说了一句废话。\n');
  await putCaret({anchor:5,head:7});
  await button.click();
  assert.equal(await doc(),'他说了一句[^1]。\n\n[^1]: 废话');
  assert.equal(await caret(),9,'选中时要把光标留在原文，紧跟在标记后面');
  await page.waitForTimeout(200);
  assert.equal(await box.inputValue(),'废话','浮框要带出被搬进注释的文字');
  await page.keyboard.press('Escape');

  // 5. The keyboard shortcut does the same thing without the button.
  await setDoc('正文。\n');
  await putCaret({anchor:3});
  // A real Shift+F produces an uppercase key. Playwright preserves the case
  // supplied here; lowercase f can trigger Ctrl+f before the shifted binding.
  await page.keyboard.press(`${platform === 'MacIntel' ? 'Meta' : 'Control'}+Shift+F`);
  assert.equal(await doc(),'正文。[^1]\n\n[^1]:','快捷键也应插入');
  assert.equal(await caret(),7,'快捷键插入后光标也停在标记后面');
  await page.keyboard.press('Escape');

  // 6. What is typed in the box is the definition in the document: the box edits
  //    the note, it does not keep a second copy of it.
  await setDoc('正文。\n');
  await putCaret({anchor:3});
  await button.click();
  await page.waitForTimeout(200);
  await page.keyboard.type('一号注释');
  assert.equal(await doc(),'正文。[^1]\n\n[^1]: 一号注释','输入框的内容要写进文末的定义');
  assert.equal(await box.inputValue(),'一号注释');
  await page.keyboard.press('Escape');

  // 7. Clicking a marker takes the reader to that note in the notes panel. The
  //    floating box is for the note being written; one that is already written is
  //    read, and corrected, in the panel.
  await putCaret({anchor:1});
  assert.deepEqual(await lines(),['正文。1','','[1] 一号注释'],'光标离开后，定义行读作编号加正文');
  await page.click('.cm-content .footnote-ref');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.footnote-box').count(),0,'已有的注释不再用浮框打开');
  assert.equal(await page.locator('#notesDrawer.visible').count(),1,'点角标要打开注释侧栏');
  assert.equal(await page.locator('.note-card.active .note-body').inputValue(),'一号注释','要带出已有的注释内容');
  assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('note-body')),true,'光标要落在那条注释里');
  await page.click('[data-close="notes"]');
  assert.equal(await page.locator('#notesDrawer.visible').count(),0,'关掉侧栏，后面的检查不受它影响');

  // 8. The same insert in a document whose labels are words: the note takes the
  //    middle number and the middle place among the definitions, and a definition
  //    nobody cites stays where the author left it.
  await setDoc('甲[^scale]，乙乙[^capital]。\n\n[^scale]: 一\n[^capital]: 二\n[^stray]: 没人引用的那条\n');
  await putCaret({anchor:'甲[^scale]，'.length});
  await button.click();
  assert.equal(await doc(),'甲[^scale]，[^2]乙乙[^capital]。\n\n[^scale]: 一\n[^2]:\n[^capital]: 二\n[^stray]: 没人引用的那条\n','文字标签的注释也要落在两条定义之间');
  await page.keyboard.press('Escape');

  // 9. What the editor writes is what the reader sees.
  await setDoc('甲[^1] 乙[^2]\n\n[^1]: A\n[^2]: B\n');
  await putCaret({anchor:1});
  await button.click();
  await page.keyboard.press('Escape');
  await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
  const refs=await page.locator('.reading-document .footnote-ref').allTextContents();
  assert.deepEqual(refs,['1','2','3'],'阅读视图的编号要与文件里的标签一致');
  const list=await page.locator('.print-footnotes-list > li').allTextContents();
  assert.equal(list.length,3,'文末要有三条注释');
  assert.equal(list[0].startsWith('A'),false,'新注释内容为空，列表里应是空卡片');
  await page.locator('.reading-document').screenshot({path:artifactPath(`leaf-footnote-insert-${platform}.png`)});

  assert.deepEqual(errors,[]);
  await page.close();
 }
  console.log('PASS 工具栏/快捷键插入脚注：选区搬运、标号重排、注释浮框、一次撤销、阅读视图一致');
} finally { await browser.close(); }
