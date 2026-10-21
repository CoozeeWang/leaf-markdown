import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch({headless:true});
  try {
    const page = await browser.newPage({locale:'zh-CN'}), errors=[];
    page.on('pageerror', error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:41732');
    await page.click('#welcomeNewButton');
    const result = await page.evaluate(async()=>{
      const {renderPrintDocument}=await import('/src/print-document.js');
      const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
      const source='正文\n\n[产品 **甲**][fund-a] [Fund-A][] [fund-a] [缺失][missing] [危险][bad]\n\n| 名称 |\n| --- |\n| [表格][fund-a] |\n\n> [!note] [提示][fund-a]\n> [内容][fund-a]\n\n[fund-a]: <https://example.invalid/one> "标题"\n[bad]: javascript:alert(1)\n\n尾段';
      window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));
      v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source},selection:{anchor:0}});
      const root=document.createElement('div');renderPrintDocument(root,source,{fallbackTitle:false});
      return {text:root.textContent,links:[...root.querySelectorAll('a[data-leaf-link]')].map(a=>[a.textContent,a.getAttribute('href')]),unchanged:v.state.doc.toString()===source};
    });
    assert.equal(result.unchanged,true);
    assert.match(result.text,/\[缺失\]\[missing\]/);
    assert.doesNotMatch(result.text,/\[fund-a\]:|javascript:|标题/);
    assert.deepEqual(result.links.map(x=>x[0]),['产品 甲','Fund-A','fund-a','表格','提示','内容']);
    assert.ok(result.links.every(x=>x[1]==='https://example.invalid/one'));
    await page.waitForFunction(()=>document.querySelectorAll('.cm-editor [data-leaf-link="https://example.invalid/one"]').length>=6);
    await page.evaluate(()=>{const at=v.state.doc.toString().indexOf('/one');v.dispatch({changes:{from:at,to:at+4,insert:'/two'}});});
    await page.waitForFunction(()=>document.querySelectorAll('.cm-editor [data-leaf-link="https://example.invalid/two"]').length>=6);
    assert.equal(await page.locator('.cm-editor [data-leaf-link="https://example.invalid/one"]').count(),0);
    const link=page.locator('.cm-editor [data-leaf-link="https://example.invalid/two"]').first();
    await link.hover();
    const cursor=()=>link.evaluate(node=>getComputedStyle(node).cursor);
    assert.notEqual(await cursor(),'pointer');
    for(const key of ['Meta','Control']) {
      await page.keyboard.down(key);
      assert.equal(await cursor(),'pointer','modifier pressed over stationary link');
      await page.keyboard.up(key);
      assert.notEqual(await cursor(),'pointer','release restores editing cursor');
    }
    await page.keyboard.down('Meta');
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    assert.notEqual(await cursor(),'pointer','switching apps clears modifier cursor');
    await page.keyboard.up('Meta');
    await page.evaluate(()=>{window.opened=[];window.open=url=>{window.opened.push(url);return null;};});
    await page.locator('.cm-editor [data-leaf-link="https://example.invalid/two"]').first().click({modifiers:['Control']});
    await page.waitForFunction(()=>window.opened.length===1);
    assert.deepEqual(await page.evaluate(()=>window.opened),['https://example.invalid/two']);
    await page.locator('#readingToggle').click();
    await page.locator('.mode-popover [data-mode=reading]').click();
    await page.locator('.reading-document a[data-leaf-link]').first().click();
    await page.waitForFunction(()=>window.opened.length===2);
    assert.deepEqual(await page.evaluate(()=>window.opened),['https://example.invalid/two','https://example.invalid/two']);
    await page.locator('.reading-document').screenshot({path:`test-results/reference-links-${engine.name()}.png`});
    assert.deepEqual(errors,[]);
    console.log(`reference-links-browser ${engine.name()}: PASS`);
  } finally { await browser.close(); }
}
