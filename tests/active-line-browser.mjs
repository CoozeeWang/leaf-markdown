import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
  const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
  const source='# 标题\n\n**粗体** 与 *斜体* 与 `代码` 与 ==高亮== 与 ~~删除~~。\n\n> 引用\n\n[链接](https://example.com) 与 <sub>2</sub>';
  await page.evaluate(async source=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source},selection:{anchor:0}});},source);
  await page.waitForTimeout(200);

  // Park the caret on the paragraph line but outside every construct on it.
  // Everything on the line must stay rendered, not fall back to markup.
  const caret=(needle,offset)=>page.evaluate(([needle,offset])=>{
    const text=v.state.doc.toString();
    v.dispatch({selection:{anchor:text.indexOf(needle)+offset}});
  },[needle,offset]);
  const lineText=needle=>page.evaluate(needle=>{
    const el=[...document.querySelectorAll('.cm-line')].find(n=>n.textContent.includes(needle));
    return el?el.textContent:null;
  },needle);

  await caret('。',1);
  await page.waitForTimeout(150);

  // Inline markup keeps its styling with the delimiters gone.
  assert.equal(await lineText('粗体'),'粗体 与 斜体 与 代码 与 高亮 与 删除。');
  const strong=page.locator('.cm-content .tok-strong').first();
  assert.equal(await strong.textContent(),'粗体');
  assert.equal(await strong.evaluate(e=>getComputedStyle(e).fontWeight),'600');
  const em=page.locator('.cm-content .tok-emphasis').first();
  assert.equal(await em.textContent(),'斜体');
  assert.equal(await em.evaluate(e=>getComputedStyle(e).fontStyle),'italic');
  const strike=page.locator('.cm-content .tok-strike').first();
  assert.equal(await strike.textContent(),'删除');
  assert.equal(await strike.evaluate(e=>getComputedStyle(e).textDecorationLine),'line-through');
  assert.equal(await page.locator('.cm-content .leaf-highlight').first().textContent(),'高亮');
  assert.equal(await page.locator('.cm-content .cm-leaf-inline-code').first().textContent(),'代码');

  // The other blocks on their own lines render too, with the caret parked here.
  assert.equal(await lineText('标题'),'标题');
  // Only the quote mark itself is hidden, so the space after it stays.
  assert.equal(await lineText('引用'),' 引用');
  const linkLine=await lineText('链接');
  assert.ok(linkLine.includes('链接') && !linkLine.includes('example.com'), `link stayed as markup: ${linkLine}`);
  assert.equal(await page.locator('.cm-content sub').first().textContent(),'2');

  // Source is never rewritten by any of this.
  assert.equal(await page.evaluate(()=>v.state.doc.toString()),source);
  await page.screenshot({path:artifactPath('leaf-active-line-rendered.png')});

  // Moving the caret into a construct reveals just that construct.
  await caret('粗体',1);
  await page.waitForTimeout(150);
  assert.equal(await lineText('粗体'),'**粗体** 与 斜体 与 代码 与 高亮 与 删除。');
  await page.screenshot({path:artifactPath('leaf-active-line-revealed.png')});

  await caret('斜体',1);
  await page.waitForTimeout(150);
  assert.equal(await lineText('粗体'),'粗体 与 *斜体* 与 代码 与 高亮 与 删除。');

  await caret('代码',1);
  await page.waitForTimeout(150);
  assert.ok((await lineText('粗体')).includes('`代码`'));

  await caret('高亮',1);
  await page.waitForTimeout(150);
  assert.ok((await lineText('粗体')).includes('==高亮=='));

  await caret('删除',1);
  await page.waitForTimeout(150);
  assert.ok((await lineText('粗体')).includes('~~删除~~'));

  // Same rule for the block-level markup and the inline HTML tags.
  await caret('标题',1);
  await page.waitForTimeout(150);
  assert.equal(await lineText('标题'),'# 标题');

  await caret('引用',1);
  await page.waitForTimeout(150);
  assert.equal(await lineText('引用'),'> 引用');

  await caret('链接',1);
  await page.waitForTimeout(150);
  assert.ok((await lineText('链接')).includes('https://example.com'));

  await caret('<sub>',1);
  await page.waitForTimeout(150);
  assert.ok((await lineText('链接')).includes('<sub>2</sub>'));
  assert.equal(await page.locator('.cm-content sub').count(),0);

  assert.deepEqual(errors,[]);
  console.log('PASS active line keeps markup rendered while the caret is outside it, and reveals one construct at a time');
} finally { await browser.close(); }
