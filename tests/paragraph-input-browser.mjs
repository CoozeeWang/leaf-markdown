import {chromium, webkit} from 'playwright';
import assert from 'node:assert/strict';
import {artifactPath} from './browser-runtime.mjs';

for (const engine of [chromium, webkit]) {
 const browser=await engine.launch({headless:true,...(engine===chromium&&process.env.LEAF_BROWSER_CHANNEL?{channel:process.env.LEAF_BROWSER_CHANNEL}:{})});
 try {
  const page=await browser.newPage({locale:'zh-CN',viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:41732/tests/native-paragraph-input.html');
  await page.waitForFunction(()=>!!window.setTestDoc);
  const set=async(text,at=text.length)=>page.evaluate(({text,at})=>setTestDoc(text,at),{text,at});
  const doc=()=>page.evaluate(()=>v.state.doc.toString());
  for(const text of ['正文',' 正文','  正文','   正文','前文 *“重点。”* 后文']){
   await set(text);await page.keyboard.press('Enter');await page.keyboard.press('Enter');await page.keyboard.type('Next paragraph');
   assert.equal((await doc()).split('\n').at(-1),'Next paragraph');
  }
  for(const [text,expected] of [['- item','- item\n- next'],['> quote','> quote\n> next'],['```js\n  code\n```','```js\n  code\n  next\n```'],['    code','    code\n    next']]){
   await set(text,text.startsWith('```')?text.indexOf('\n```'):text.length);
   await page.keyboard.press('Enter');await page.keyboard.type('next');assert.equal(await doc(),expected);
  }
  await set(' 正文');await page.evaluate(()=>testEditor.setSource(true));
  await page.keyboard.press('Enter');assert.equal(await doc(),' 正文\n ');
  await page.evaluate(()=>testEditor.setSource(false));
  const old='既有缺定义[^old]';await set(old);await page.keyboard.type('。');assert.equal(await doc(),old+'。');
  const source='正文[^1]。\n\n新引用[]\n\n[^1]: 原注',at=source.indexOf('[]')+1;
  await set(source,at);await page.keyboard.type('^66');
  assert.equal(await doc(),source.replace('[]','[^66]'));
  await page.keyboard.press('ArrowRight');
  const complete=source.replace('[]','[^2]')+'\n\n[^2]:';
  assert.equal(await doc(),complete);
  await page.evaluate(()=>testEditor.undo());assert.equal(await doc(),source);
  await page.evaluate(()=>testEditor.redo());assert.equal(await doc(),complete);
  // Exercise composition timing through the actual editor event handlers. This
  // is a simulated IME sequence, not a claim about an installed input method.
  await set(source,at);
  await page.evaluate(at=>{
   v.contentDOM.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
   v.dispatch({changes:{from:at,insert:'^6'},selection:{anchor:at+2},userEvent:'input.type.compose.start'});
  },at);
  assert.equal(await doc(),source.replace('[]','[^6]'));
  await page.evaluate(()=>v.contentDOM.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'^6'})));
  await page.evaluate(at=>v.dispatch({selection:{anchor:at+3},userEvent:'select'}),at);
  await page.waitForFunction(()=>v.state.doc.toString().endsWith('[^2]:'));
  assert.equal(await doc(),complete);
  await page.evaluate(()=>testEditor.undo());assert.equal(await doc(),source);
  await page.evaluate(()=>testEditor.redo());assert.equal(await doc(),complete);
  await page.evaluate(()=>{v.dispatch({selection:{anchor:0}});});
  assert.deepEqual(await page.locator('#editor .footnote-ref').allTextContents(),['1','2']);
  await page.screenshot({path:artifactPath(`paragraph-input-${engine.name()}.png`)});
  assert.deepEqual(errors,[]);
  console.log(`PASS ${engine.name()} prose Enter, structural indentation, paired brackets, deferred composition, empty-note superscript, undo/redo and source mode`);
 } finally {await browser.close();}
}
