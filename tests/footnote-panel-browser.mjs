import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
  const page=await browser.newPage({viewport:{width:1280,height:900},deviceScaleFactor:2}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:41732');
  const drawer=page.locator('#notesDrawer');
  assert.equal(await drawer.isVisible(),false,'欢迎页不该有注释侧栏');

  await page.click('#welcomeNewButton');
  await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});
  const setDoc=text=>page.evaluate(t=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:t}});},text);
  const doc=()=>page.evaluate(()=>v.state.doc.toString());
  const rows=()=>page.evaluate(()=>[...document.querySelectorAll('.note-card')].map(card=>[
    card.dataset.label,card.dataset.number,card.querySelector('.note-number').textContent,
    card.querySelector('.note-body').value,card.dataset.state]));
  const active=()=>page.evaluate(()=>document.querySelector('.note-card.active')?.dataset.label??null);
  const focusTag=()=>page.evaluate(()=>{
    const el=document.activeElement;
    if(el.classList.contains('note-body'))return 'note-body';
    if(el.classList.contains('cm-content'))return 'cm-content';
    return el.tagName.toLowerCase();
  });
  // Leaving a note is what lets the panel redraw: it never rebuilds under a
  // caret, or a pinyin run being typed would be cut in half.
  const leaveNote=async()=>{await page.click('.cm-content',{position:{x:6,y:6}});await page.waitForTimeout(120);};

  // The collapsed edge rail opens the panel without a toolbar control.
  const button=page.locator('#notesButton');
  assert.equal(await button.count(),1,'侧边应有注释展开入口');
  assert.equal(await button.getAttribute('aria-label'),'展开注释');
  assert.equal(await button.getAttribute('data-tooltip'),'展开注释');
  assert.equal(await button.locator('svg.ui-icon path').count()>0,true,'按钮要有矢量图标');
  assert.equal(await button.getAttribute('aria-pressed'),'false');
  assert.equal(await drawer.isVisible(),false,'默认收起');

  await page.click('#notesButton');
  assert.equal(await drawer.isVisible(),true,'点按钮要展开');
  assert.equal(await button.getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('.notes-list .empty-hint').textContent(),'此文档没有注释');

  // 1. The list follows the reader's order, not the labels and not the order the
  //    definitions happen to sit in the file -- 丙 is cited first so it leads.
  await setDoc('丙[^c] 甲[^a] 乙[^b] 悬空[^d]\n\n[^a]: 甲注释\n[^b]: 乙注释\n[^c]: 丙注释\n[^orphan]: 没人引用\n');
  await page.waitForTimeout(120);
  assert.deepEqual(await rows(),[
    ['c','1','1','丙注释','complete'],
    ['a','2','2','甲注释','complete'],
    ['b','3','3','乙注释','complete'],
    ['d','','[d]','','undefined'],
    ['orphan','','[orphan]','没人引用','unreferenced'],
  ],'按引用顺序编号，掉队的注释也要留在列表里');

  // 2. A row is the note, not a copy of it: what is typed here is the definition
  //    in the file, in the same shape a note inserted from the toolbar gets.
  const body=page.locator('.note-card[data-label="a"] .note-body');
  await body.click();
  await page.keyboard.press('End');
  await page.keyboard.type('续写');
  assert.equal(await doc(),'丙[^c] 甲[^a] 乙[^b] 悬空[^d]\n\n[^a]: 甲注释续写\n[^b]: 乙注释\n[^c]: 丙注释\n[^orphan]: 没人引用\n','侧栏里写的就是文末的定义');

  // A second line goes in with the indent that keeps it inside the definition,
  // and reads back without it.
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('第二行');
  assert.equal(await doc(),'丙[^c] 甲[^a] 乙[^b] 悬空[^d]\n\n[^a]: 甲注释续写\n    第二行\n[^b]: 乙注释\n[^c]: 丙注释\n[^orphan]: 没人引用\n','换行要续在同一个定义里');
  assert.equal(await body.inputValue(),'甲注释续写\n第二行','方框里读回的是去掉缩进的原文');

  // Enter leaves the note instead of adding a line, so the keyboard never gets
  // stuck in the panel.
  await page.keyboard.press('Enter');
  assert.equal(await focusTag(),'cm-content','回车要回到正文');
  await page.waitForTimeout(120);

  // 3. A citation with no definition gets one the moment it is written in, and
  //    the list redraws with its number once the caret leaves.
  const missing=page.locator('.note-card[data-label="d"] .note-body');
  assert.equal(await missing.count(),1,'没有定义的引用也要有一行');
  await missing.fill('补上的注释');
  assert.equal(await doc(),'丙[^c] 甲[^a] 乙[^b] 悬空[^d]\n\n[^a]: 甲注释续写\n    第二行\n[^b]: 乙注释\n[^c]: 丙注释\n[^orphan]: 没人引用\n\n[^d]: 补上的注释','补写要真的落成一条定义');
  await leaveNote();
  assert.deepEqual((await rows()).map(row=>row.slice(0,2)),[['c','1'],['a','2'],['b','3'],['d','4'],['orphan','']],'补写之后这一行要有编号');

  // 4. The number on a row is a way back into the text.
  await page.locator('.note-card[data-label="b"] .note-number').click();
  assert.equal(await focusTag(),'cm-content','点编号要回到编辑器');
  assert.equal(await doc().then(text=>text.startsWith('丙[^c]')),true,'跳转不该改动文档');

  // 5. A click on a marker brings the panel up with that note in it and the caret
  //    in the note, which is what makes the pair feel like one thing.
  await page.click('[data-close="notes"]');
  assert.equal(await drawer.isVisible(),false,'关闭按钮要收起侧栏');
  await page.click('.cm-content .footnote-ref >> nth=1');
  await page.waitForTimeout(120);
  assert.equal(await drawer.isVisible(),true,'点角标要把侧栏打开');
  assert.equal(await active(),'a','要定位到被点的那个角标对应的注释');
  assert.equal(await focusTag(),'note-body','光标要落在那条注释里');

  // 6. A note written over several lines is shown whole, not in a one-line box.
  await setDoc('引用。[^1]\n\n[^1]: 第一段\n    第二行\n    第三行\n');
  await leaveNote();
  const measured=await page.evaluate(()=>{
    const one=document.querySelector('.note-card[data-number="1"] .note-body');
    return {clientHeight:one.clientHeight,scrollHeight:one.scrollHeight};
  });
  assert.ok(measured.clientHeight>40,`多行注释要撑开，实际 ${measured.clientHeight}px`);
  assert.ok(Math.abs(measured.clientHeight-measured.scrollHeight)<=1,'方框高度要正好装下内容');

  // 7. The reading view is where a note is read the way it prints, so the panel
  //    stops offering an edit there -- and clicking a printed citation lights up
  //    the matching row.
  await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
  await page.waitForTimeout(180);
  assert.equal(await page.locator('.note-card[data-number="1"] .note-body').getAttribute('readonly'),'','阅读模式下不可改写');
  await page.click('.reading-document .footnote-ref >> nth=0');
  await page.waitForTimeout(100);
  assert.equal(await active(),'1','阅读视图里点角标也要点亮对应的一行');
  await page.screenshot({path:artifactPath('leaf-notes-reading.png')});
  await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
  await page.waitForTimeout(180);
  assert.equal(await page.locator('.note-card[data-number="1"] .note-body').getAttribute('readonly'),null,'回到编辑模式要能改写');

  // 8. A note cited twice is one row, and nothing the panel does may reach the
  //    file's own structure.
  await setDoc('引用。[^1] 又一处[^1]\n\n[^1]: 一号\n');
  await leaveNote();
  assert.equal(await page.locator('.note-card').count(),1,'同一个注释引用两次仍只有一条');
  assert.equal(await doc(),'引用。[^1] 又一处[^1]\n\n[^1]: 一号\n');

  await page.screenshot({path:artifactPath('leaf-notes-drawer.png')});

  // 9. The box under a fresh marker and the panel are one note seen twice: what
  //    the box writes shows up in the matching row while it is being typed.
  await setDoc('正文。\n');
  await page.evaluate(()=>{v.dispatch({selection:{anchor:3}});v.focus();});
  await page.click('[data-format="footnote"]');
  await page.waitForTimeout(200);
  // The row must not be rebuilt for every character: the panel would then cost a
  // textarea per note in the document each time a key is pressed.
  await page.evaluate(()=>{window.__row=document.querySelector('.note-card .note-body');});
  await page.keyboard.type('新写的');
  assert.equal(await page.evaluate(()=>window.__row===document.querySelector('.note-card .note-body')),true,'改字只该改字，不该重建整行');
  assert.equal(await page.locator('.footnote-box textarea').inputValue(),'新写的');
  assert.equal(await page.locator('.note-card[data-number="1"] .note-body').inputValue(),'新写的','浮框里写的要同步到侧栏');
  assert.equal(await doc(),'正文。[^1]\n\n[^1]: 新写的','两边写的还是同一条定义');
  await page.keyboard.press('Escape');
  assert.equal(await focusTag(),'cm-content','关掉浮框要回到正文');

  const deletionSource='正文[^a] 再次[^a] 保留[^b]\n\n[^a]: 删除内容\n    第二行\n[^b]: 保留内容\n[^orphan]: 孤立内容';
  await setDoc(deletionSource);
  await page.locator('.note-card[data-label="orphan"] .note-delete').click();
  assert.ok(!(await doc()).includes('孤立内容'));
  assert.equal(await page.locator('.note-card[data-label="orphan"]').count(),0);
  await page.click('#undoButton');
  assert.equal(await doc(),deletionSource,'删除孤立定义可一次撤销');
  await page.locator('.note-card[data-label="a"] .note-delete').click();
  assert.ok(!(await doc()).includes('[^a]'));
  assert.ok(!(await doc()).includes('第二行'));
  assert.ok((await doc()).includes('[^b]: 保留内容'));
  await page.click('#undoButton');
  assert.equal(await doc(),deletionSource,'所有引用与多行定义一起撤销');
  await page.click('#redoButton');
  assert.ok(!(await doc()).includes('[^a]'));
  assert.deepEqual(errors,[]);
  console.log('PASS 注释侧栏：收起展开、按序列出、就地改写、角标与行互跳、掉队的注释、阅读模式只读');
} finally { await browser.close(); }
