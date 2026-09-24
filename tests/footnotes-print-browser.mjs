import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const source=[
  '# 标题',
  '',
  '正文一[^a] 与正文二[^b]。',
  '',
  '正文三[^a] 再引用一次。',
  '',
  '| 列 | 值 |',
  '| --- | --- |',
  '| 表格 [^c] | x |',
  '',
  '> [!note] 提示',
  '> 引用块里的 [^b]。',
  '',
  '```text',
  '[^fake] 不是脚注',
  '```',
  '',
  '[^a]: 第一条注释',
  '    续行内容',
  '    - 列表项',
  '[^b]: 第二条',
  '[^c]: 第三条',
  '[^orphan]: 没人引用它',
  '',
  '正文四[^ghost]。',
  '',
].join('\n');
const browser=await chromium.launch(launchOptions);
try {
  const page=await browser.newPage({viewport:{width:1200,height:900},deviceScaleFactor:2}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
  await page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));});
  await page.evaluate(text=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text}});},source);
  await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
  const doc=page.locator('.reading-document');

  // Numbers come from the order the citations appear in the body, so the third
  // citation of the same label still prints as 1 and the table cell counts too.
  const refs=await doc.locator('.footnote-ref').allTextContents();
  assert.deepEqual(refs,['1','2','1','3','2'],'引用编号应按正文出现顺序');
  assert.equal(await doc.locator('.footnote-ref a').nth(0).getAttribute('href'),'#fn-1');
  const ids=await doc.locator('.footnote-ref a').evaluateAll(nodes=>nodes.map(n=>n.id));
  assert.deepEqual(ids,['fnref-1','fnref-2','fnref-1-2','fnref-3','fnref-2-2'],'同一脚注的第二次引用要有独立锚点');

  // The definition block leaves the flow entirely, including the continuation
  // line that the base grammar used to hand back as a code block.
  const paragraphs=await doc.locator('p').allTextContents();
  assert.equal(paragraphs.some(t=>t.includes('[^a]:')),false,'定义标记不应出现在正文');
  assert.equal(await doc.locator('pre').filter({hasText:'续行内容'}).count(),0,'续行不应渲染成代码块');
  assert.equal(paragraphs.some(t=>t.includes('没人引用它')),false,'孤儿定义不应渲染');

  const section=doc.locator('.print-footnotes');
  assert.equal(await section.count(),1,'文末应有脚注区块');
  assert.equal(await section.locator('.print-footnotes-list > li').count(),3,'只列出被引用的三条');
  const first=await section.locator('#fn-1').textContent();
  assert.ok(first.includes('第一条注释')&&first.includes('续行内容')&&first.includes('列表项'),'多行定义应完整渲染');
  assert.ok((await section.locator('#fn-1 ul li').first().textContent()).startsWith('列表项'),'定义里的列表应保留块级形态');
  assert.equal(await section.locator('#fn-1 .footnote-backref').getAttribute('href'),'#fnref-1');
  // The arrow belongs to the end of the note's text, not to a line of its own.
  assert.equal(await section.locator('#fn-2 .footnote-text > p > .footnote-backref').count(),1,'段落结尾的箭头应落在段内');
  assert.equal(await section.locator('#fn-1 .footnote-text > ul > li > p > .footnote-backref').count(),1,'列表结尾的箭头应落在末项文字里');

  // A citation with no definition is not a footnote: it stays as written instead
  // of dangling a number, and it must not consume a slot in the numbering.
  assert.equal((await doc.locator('p').allTextContents()).some(t=>t.includes('[^ghost]')),true,'无定义的引用应原样保留');
  assert.equal(await section.locator('.print-footnotes-list > li').count(),3);

  const fence=await doc.locator('pre code').allTextContents();
  assert.equal(fence.some(t=>t.includes('[^fake]')),true,'代码围栏内容应原样保留');
  assert.equal(refs.includes('4'),false,'代码里的假引用不应编号');

  await page.locator('.reading-document').screenshot({path:artifactPath('leaf-footnotes-reading.png')});

  // Two citations written side by side are a single Link node to the parser --
  // it reads "[^1][^2]" as a reference link whose text is "^1" -- so both have
  // to be taken back out of it. The insert control produces this shape whenever
  // a note goes in immediately before an existing citation.
  await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
  await page.evaluate(()=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'甲[^a][^b]。\n\n[^a]: A\n[^b]: B\n'}});});
  await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
  assert.deepEqual(await page.locator('.reading-document .footnote-ref').allTextContents(),['1','2'],'并排的两个引用要各自渲染');

  // The export page renders through the same function but a different stylesheet,
  // and it is the path that ends up in a PDF, so check it separately.
  await page.evaluate(snapshot=>sessionStorage.setItem('leaf-test-export',JSON.stringify(snapshot)),{source,name:'测试.md',numbered:false});
  await page.goto('http://127.0.0.1:41732/?export=leaf-test-export');
  await page.waitForSelector('.print-document .print-footnotes');
  assert.equal(await page.locator('.print-document .footnote-ref').count(),5,'导出页也应渲染脚注引用');
  assert.equal(await page.locator('.print-document .print-footnotes-list > li').count(),3);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.print-document .footnote-ref')).verticalAlign),'super','导出页角标应为上标');
  await page.locator('.print-document').screenshot({path:artifactPath('leaf-footnotes-pdf.png')});

  // Native pagination clips markers outside the printable content. Check that
  // a three-digit marker fits inside the document, using the rendered font.
  const many = Array.from({length:180}, (_,i)=>`引用[^n${i}]`).join(' ') + '\n\n' +
    Array.from({length:180}, (_,i)=>`[^n${i}]: 注释 ${i+1}`).join('\n');
  const geometry = await page.evaluate(async source => {
    const { renderPrintDocument } = await import('/src/print-document.js');
    const root = document.querySelector('.print-document');
    renderPrintDocument(root, source);
    const item = root.querySelector('#fn-180'), style = getComputedStyle(item);
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
    context.font = `${style.fontSize} ${style.fontFamily}`;
    return { available: item.getBoundingClientRect().left - root.querySelector('.print-footnotes').getBoundingClientRect().left,
      required: context.measureText('180. ').width };
  }, many);
  assert.ok(geometry.available >= geometry.required, 'three-digit footnote markers must fit within printable margins');

  assert.deepEqual(errors,[]);
  console.log('PASS footnotes render as superscripts, leave the flow and list at the end');
} finally { await browser.close(); }
