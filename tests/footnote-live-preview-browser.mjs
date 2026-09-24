import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const source=[
  '# 标题',
  '',
  '正文一[^a] 与正文二[^b]。',
  '',
  '```text',
  '[^fake] 不是脚注',
  '```',
  '',
  '光标停在这一行。',
  '',
  '[^a]: 第一条注释',
  '[^b]: 第二条',
  '',
  '正文三[^ghost]。',
  '',
].join('\n');
const browser=await chromium.launch(launchOptions);
try {
  const page=await browser.newPage({viewport:{width:1200,height:900},deviceScaleFactor:2}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:41732');await page.waitForTimeout(600);await page.click('#welcomeNewButton',{force:true});
  await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});
  await page.evaluate(text=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text}});},source);
  // Park the caret away from every construct under test: live preview only hides
  // markup while you are not editing it.
  await page.evaluate(()=>{const s=v.state.doc.toString(),i=s.indexOf('光标停在这一行');v.dispatch({selection:{anchor:i+2,head:i+2}});});
  await page.waitForTimeout(300);

  const lineText=()=>page.locator('.cm-line').allTextContents();
  const refs=()=>page.locator('.cm-content .footnote-ref').allTextContents();

  // A citation prints the number the reading view prints, not the label in the
  // file, and it prints it raised rather than as the marker with the caret in it.
  assert.deepEqual(await refs(),['1','2'],'引用应渲染成数字角标');
  assert.equal(await page.locator('.cm-content .leaf-inline-link').count(),0,'引用不应再留下一个链接');
  const style=await page.locator('.cm-content .footnote-ref').first().evaluate(el=>{
    const cs=getComputedStyle(el);
    return {va:cs.verticalAlign,deco:cs.textDecorationLine,size:parseFloat(cs.fontSize),color:cs.color,content:getComputedStyle(document.querySelector('.cm-content')).color};
  });
  assert.equal(style.va,'super','角标应为上标');
  assert.equal(style.deco,'none','角标不应带下划线');
  assert.ok(style.size<15,'角标应比正文小');
  assert.notEqual(style.color,style.content,'角标应带链接色，与正文区分');

  // The grammar has no footnote syntax and hands "[^a]: text" back as a link
  // reference definition, which tints the body as if it were a URL. Away from the
  // caret the marker is drawn as the note's number: brackets kept, the caret and
  // the colon gone, and at the size of the line it labels rather than raised.
  const labels=await page.locator('.cm-content .leaf-footnote-label').evaluateAll(nodes=>nodes.map(n=>n.textContent));
  assert.deepEqual(labels,['[1]','[2]'],'定义行应读作编号加正文');
  const labelStyle=await page.locator('.cm-content .leaf-footnote-label').first().evaluate(el=>{
    const cs=getComputedStyle(el),line=getComputedStyle(document.querySelector('.cm-content'));
    return {va:cs.verticalAlign,size:parseFloat(cs.fontSize),color:cs.color,lineSize:parseFloat(line.fontSize),lineColor:line.color};
  });
  assert.equal(labelStyle.va,'baseline','定义行的编号不应是上标');
  assert.equal(labelStyle.size,labelStyle.lineSize,'定义行的编号应与正文同字号');
  assert.notEqual(labelStyle.color,labelStyle.lineColor,'定义行的编号应更淡，与正文区分');
  const def=await page.locator('.cm-content .leaf-footnote-body').evaluateAll(nodes=>nodes.map(el=>{
    const inner=el.querySelector('.tok-url')??el,cs=getComputedStyle(inner);
    return {text:inner.textContent,deco:cs.textDecorationLine,color:cs.color};
  }));
  assert.deepEqual(def.map(d=>d.text),['第一条注释','第二条']);
  assert.equal(def.some(d=>d.deco!=='none'),false,'定义正文不应像链接一样带下划线');
  assert.equal(def.some(d=>d.color===labelStyle.color),false,'定义正文不应与编号同色（编号要更淡）');
  assert.equal(def.some(d=>d.color===style.content),true,'定义正文应回到正文颜色');

  // A citation whose definition has not been written is not a footnote: it stays
  // as written, and it must not take a number slot from the ones that have one.
  assert.equal((await lineText()).some(t=>t.includes('正文三[^ghost]。')),true,'无定义的引用应原样保留');
  assert.deepEqual(await refs(),['1','2']);

  // The editor and the reading view must never disagree about a number: they read
  // the same rule out of the same module.
  await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
  assert.deepEqual(await page.locator('.reading-document .footnote-ref').allTextContents(),['1','2'],'阅读视图编号应与编辑器一致');
  await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();

  // A number is not part of the citation's source text, so a widget that only
  // compared its text would keep printing the old number after the definition is
  // written or removed somewhere else. The caret never moves in these steps.
  await page.evaluate(()=>{const s=v.state.doc.toString(),i=s.indexOf('[^ghost]。');v.dispatch({changes:{from:i,to:s.length,insert:'[^ghost]。\n\n[^ghost]: 补上的注释\n'}});});
  await page.waitForTimeout(200);
  assert.deepEqual(await refs(),['1','2','3'],'补上定义后角标应自己出现');
  await page.evaluate(()=>{const s=v.state.doc.toString(),i=s.indexOf('\n\n[^ghost]: 补上的注释');v.dispatch({changes:{from:i,to:s.length,insert:'\n'}});});
  await page.waitForTimeout(200);
  assert.deepEqual(await refs(),['1','2'],'删掉定义后角标应退回原样标记');
  assert.equal((await lineText()).some(t=>t.includes('正文三[^ghost]。')),true);

  // A note inserted before the existing ones shifts every number after it.
  await page.evaluate(()=>{const s=v.state.doc.toString(),i=s.indexOf('正文一');v.dispatch({changes:{from:i,to:i,insert:'零[^z]。\n\n'}});});
  await page.evaluate(()=>{const s=v.state.doc.toString(),i=s.indexOf('正文三');v.dispatch({changes:{from:i,to:i,insert:'[^z]: 第零条\n\n'}});});
  await page.waitForTimeout(200);
  assert.deepEqual(await refs(),['1','2','3'],'前面插一条后编号应整体后移');

  // Live preview only hides markup while the caret is outside it, so the marker
  // has to come back the moment you put the caret in it.
  await page.evaluate(()=>{const s=v.state.doc.toString(),i=s.indexOf('正文一');v.dispatch({selection:{anchor:i+3,head:i+3}});});
  await page.waitForTimeout(200);
  assert.equal((await lineText()).some(t=>t.includes('正文一[^a]')),true,'光标进入引用时应显示原文');

  // The fake citation lives inside a fence and is not a footnote anywhere.
  assert.equal((await lineText()).some(t=>t.includes('[^fake] 不是脚注')),true,'代码围栏内容应原样保留');

  await page.screenshot({path:artifactPath('leaf-footnote-live-preview.png'),clip:{x:0,y:90,width:900,height:420}});

  // A definition that does not open a block -- right under a paragraph with no
  // blank line between them, or inside a list item -- is read by the grammar as a
  // link, and the citation pass used to print its number with the definition's own
  // colon left dangling behind it. The label belongs to the line either way.
  await page.evaluate(()=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'正文甲[^k]。\n[^k]: 紧接正文的定义\n\n- 列表里的正文[^m]。\n  [^m]: 列表里的定义\n'}});});
  await page.evaluate(()=>{v.dispatch({selection:{anchor:1,head:1}});});
  await page.waitForTimeout(250);
  assert.deepEqual(await refs(),['1','2'],'两种写法都应渲染成数字角标，而不是把标号当引用');
  const flat=(await lineText()).join('\n');
  assert.equal(flat.includes('[1] 紧接正文的定义'),true,'紧接正文的定义行应读作编号加正文');
  assert.equal(flat.includes('[2] 列表里的定义'),true,'列表里的定义行应读作编号加正文');
  assert.equal(flat.includes(':'),false,'定义行的冒号不应留下');
  await page.screenshot({path:artifactPath('leaf-footnote-definition-lines.png'),clip:{x:0,y:90,width:900,height:300}});

  // A note with more than one line is held inside the definition by an indent the
  // file needs and the reader should not see. The grammar reads that line as code
  // on top of it, so the note would otherwise come out indented and monospaced.
  await page.evaluate(()=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'正文[^n]。\n\n[^n]: 第一条\n    续行内容\n    再来一行\n'}});});
  await page.evaluate(()=>{v.dispatch({selection:{anchor:0,head:0}});});
  await page.waitForTimeout(250);
  assert.deepEqual(await refs(),['1'],'多行注释的引用也应编号');
  assert.deepEqual((await lineText()).filter(t=>t.trim()).slice(-3),['[1] 第一条','续行内容','再来一行'],'续行的缩进应被隐藏');
  const cont=await page.locator('.cm-content .leaf-footnote-body').last().evaluate(el=>{
    const inner=el.querySelector('.tok-code')??el,cs=getComputedStyle(inner),line=getComputedStyle(document.querySelector('.cm-content'));
    return {font:cs.fontFamily,lineFont:line.fontFamily,color:cs.color,lineColor:line.color};
  });
  assert.equal(await page.locator('.cm-leaf-code-block').count(),0,'脚注续行不应带代码块背景或间距');
  assert.equal(cont.font,cont.lineFont,'续行应与正文同字体，不该是等宽');
  assert.equal(cont.color,cont.lineColor,'续行应回到正文颜色');
  await page.screenshot({path:artifactPath('leaf-footnote-continuation.png'),clip:{x:0,y:90,width:900,height:300}});

  // Live preview only hides markup while the caret is outside it, and a definition
  // is one construct: the indent comes back with the marker, not on its own.
  await page.evaluate(()=>{const s=v.state.doc.toString(),i=s.indexOf('续行内容');v.dispatch({selection:{anchor:i+1,head:i+1}});});
  await page.waitForTimeout(200);
  assert.equal((await lineText()).join('\n').includes('    续行内容'),true,'光标进入定义时应显示续行的原始缩进');

  assert.deepEqual(errors,[]);
  console.log('PASS citations render as numbers in the editor, definitions stop looking like links');
} finally { await browser.close(); }
