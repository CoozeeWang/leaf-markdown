import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
  const page=await browser.newPage({viewport:{width:1100,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
  const source='# 上下标\n\n水分子 H<sub>2</sub>O，面积 5m<sup>2</sup>。\n\n行内代码 `<sup>2</sup>` 保持字面。\n\n未闭合 <sup>2 也应保持字面。\n\n嵌套 a<sup>b<sup>c</sup></sup>d。';
  await page.evaluate(async source=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source},selection:{anchor:0}});},source);
  await page.waitForTimeout(200);

  // Editor: paired tags render as real elements with the right alignment.
  assert.deepEqual(await page.locator('.cm-content sup').allTextContents(),['2','bc','c']);
  assert.deepEqual(await page.locator('.cm-content sub').allTextContents(),['2']);
  assert.equal(await page.locator('.cm-content sup').first().evaluate(e=>getComputedStyle(e).verticalAlign),'super');
  assert.equal(await page.locator('.cm-content sub').first().evaluate(e=>getComputedStyle(e).verticalAlign),'sub');

  // Inline code and unpaired tags stay literal text.
  const code=page.locator('.cm-content .cm-leaf-inline-code').first();
  assert.equal(await code.textContent(),'<sup>2</sup>');
  assert.equal(await code.locator('sup,sub').count(),0);
  assert.ok((await page.locator('.cm-content').innerText()).includes('未闭合 <sup>2'));

  // Visual-only: the stored source is never rewritten.
  assert.equal(await page.evaluate(()=>v.state.doc.toString()),source);
  await page.screenshot({path:artifactPath('leaf-inline-html-editor.png')});

  // Moving the caret inside the pair reveals its markup again; markup elsewhere
  // on the line stays rendered.
  await page.evaluate(()=>{const i=v.state.doc.toString().indexOf('H<sub>');v.dispatch({selection:{anchor:i+2}});});
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.cm-content sub').count(),0);
  assert.ok((await page.locator('.cm-content').innerText()).includes('H<sub>2</sub>O'));

  // Toolbar buttons and shortcuts wrap the selection with the matching tags.
  const doc=()=>page.evaluate(()=>v.state.doc.toString());
  await page.evaluate(()=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'m2\n\nx2'},selection:{anchor:0,head:1}});});
  await page.locator('.format-toolbar button[data-format="sup"]').click();
  assert.equal(await doc(),'<sup>m</sup>2\n\nx2');
  await page.evaluate(()=>{const i=v.state.doc.toString().indexOf('x2');v.dispatch({selection:{anchor:i,head:i+1}});});
  await page.locator('.format-toolbar button[data-format="sub"]').click();
  assert.equal(await doc(),'<sup>m</sup>2\n\n<sub>x</sub>2');

  // Clicking again on an already wrapped selection unwraps it.
  await page.evaluate(()=>v.dispatch({selection:{anchor:0,head:12}}));
  await page.locator('.format-toolbar button[data-format="sup"]').click();
  assert.equal(await doc(),'m2\n\n<sub>x</sub>2');

  // Keyboard shortcuts: ⌘. for superscript, ⌘, for subscript. With no
  // selection the caret lands between the tags, same as ⌘B does for bold.
  const reset=(insert,anchor,head)=>page.evaluate(([insert,anchor,head])=>{
    v.dispatch({changes:{from:0,to:v.state.doc.length,insert},selection:{anchor,head}});v.focus();
  },[insert,anchor,head]);
  await reset('',0,0);
  await page.keyboard.press('ControlOrMeta+.');
  assert.equal(await doc(),'<sup></sup>');
  assert.equal(await page.evaluate(()=>v.state.selection.main.head),5);
  await reset('',0,0);
  await page.keyboard.press('ControlOrMeta+,');
  assert.equal(await doc(),'<sub></sub>');
  assert.equal(await page.evaluate(()=>v.state.selection.main.head),5);
  await reset('2',0,1);
  await page.keyboard.press('ControlOrMeta+.');
  assert.equal(await doc(),'<sup>2</sup>');
  await page.keyboard.press('ControlOrMeta+z');
  assert.equal(await doc(),'2');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  assert.equal(await doc(),'<sup>2</sup>');

  // Formatting has to stay undoable once the pair is rendered and the caret
  // sits outside it — the toolbar insert is a programmatic change, so the
  // application menu must route Cmd-Z into the editor's own history.
  await reset('',0,0);
  await page.keyboard.type('前后');
  await page.evaluate(()=>{const i=v.state.doc.toString().indexOf('前');v.dispatch({selection:{anchor:i,head:i+1}});v.focus();});
  await page.locator('.format-toolbar button[data-format="sup"]').click();
  assert.equal(await doc(),'<sup>前</sup>后');
  // Wrapping leaves the caret on the closing boundary, which still counts as
  // inside, so move it off the pair before checking the rendered state.
  await page.evaluate(()=>{v.dispatch({selection:{anchor:v.state.doc.length}});v.focus();});
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.cm-content sup').count(),1);
  await page.keyboard.press('ControlOrMeta+z');
  assert.equal(await doc(),'前后');
  assert.equal(await page.locator('.cm-content sup').count(),0,'撤销后必须回到纯文本');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  assert.equal(await doc(),'<sup>前</sup>后');

  await page.evaluate(source=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source},selection:{anchor:0}});},source);
  await page.waitForTimeout(150);

  // Reading view shares the same renderer.
  await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
  await page.locator('.reading-document sup').first().waitFor();
  assert.deepEqual(await page.locator('.reading-document sup').allTextContents(),['2','bc','c']);
  assert.deepEqual(await page.locator('.reading-document sub').allTextContents(),['2']);
  assert.equal(await page.locator('.reading-document sub').first().evaluate(e=>getComputedStyle(e).verticalAlign),'sub');
  assert.equal(await page.locator('.reading-document code').first().textContent(),'<sup>2</sup>');
  assert.ok((await page.locator('.reading-document').innerText()).includes('未闭合 <sup>2'));
  assert.equal(await page.locator('.format-toolbar button[data-format="sup"]').isVisible(),false);
  await page.screenshot({path:artifactPath('leaf-inline-html-reading.png')});

  // Print/PDF document path.
  await page.evaluate(source=>sessionStorage.setItem('fixture-inline',JSON.stringify({source,name:'上下标.md'})),source);
  await page.goto('http://127.0.0.1:41732/?export=fixture-inline');
  await page.locator('article h1').waitFor();
  assert.equal(await page.locator('article sup').count(),3);
  assert.equal(await page.locator('article sub').count(),1);
  assert.equal(await page.locator('article sup').first().evaluate(e=>getComputedStyle(e).verticalAlign),'super');
  assert.equal(await page.locator('article code').first().textContent(),'<sup>2</sup>');
  assert.ok((await page.locator('article').innerText()).includes('未闭合 <sup>2'));

  assert.deepEqual(errors,[]);
  console.log('PASS editor, reading and print paths render paired <sup>/<sub>, keep code and unpaired tags literal, and stay undoable');
} finally { await browser.close(); }
