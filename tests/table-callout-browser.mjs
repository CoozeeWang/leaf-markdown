import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser = await chromium.launch(launchOptions);
try {
  const page = await browser.newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:41732'); await page.click('#welcomeNewButton');
  await page.evaluate(async()=>{
    const {createLeafEditor} = await import('/src/editor.js');
    document.querySelector('#editor').replaceChildren();
    window.fixture=createLeafEditor({parent:document.querySelector('#editor'),doc:'| 内容 |\n| --- |\n| 甲<br>乙 |\n\n正文'});
  });
  assert.equal(await page.locator('td .leaf-cell-preview br').count(),1);
  await page.locator('td .leaf-cell-preview').click();
  const input=page.locator('textarea[data-row="1"]');
  assert.equal(await input.inputValue(),'甲\n乙');
  await input.evaluate(el=>{window.originalInput=el; el.setSelectionRange(2,2);});
  for(let i=0;i<1;i++) {
    await page.keyboard.press('Backspace');
    const result=await input.evaluate(el=>({same:el===originalInput,focused:el===document.activeElement,pos:el.selectionStart,value:el.value}));
    console.log(result); assert.ok(result.same&&result.focused); assert.equal(result.pos,1);
  }
  await page.keyboard.insertText('；');
  assert.equal(await input.inputValue(),'甲；乙');
  await page.evaluate(()=>fixture.setValue('> [!warning] **注意事项**\n> 正文第一行<br>第二行\n>\n> - 项目一\n> - 项目二\n\n> [!tip]- 折叠提示\n> 隐藏的内容\n>\n> > [!info] 嵌套信息\n> > 里面的正文\n\n正文'));
  assert.equal(await page.locator('.leaf-callout[data-type="warning"]').count(),1);
  assert.equal(await page.locator('.leaf-callout[data-type="warning"] li').count(),2);
  assert.equal(await page.locator('details.leaf-callout').getAttribute('open'),null);
  await page.locator('summary').click();
  assert.notEqual(await page.locator('details.leaf-callout').getAttribute('open'),null);
  assert.equal(await page.locator('.leaf-callout[data-type="info"]').count(),1);
  const before=await page.evaluate(()=>fixture.getValue());
  await page.locator('.leaf-callout-widget').first().locator('.leaf-callout-body > .leaf-callout-preview').click();
  await page.getByRole('textbox',{name:'提示块内容',exact:true}).first().press('Tab');
  assert.equal(await page.locator('.leaf-callout-widget .leaf-block-top, .leaf-table .leaf-block-top').count(),0);
  assert.equal(await page.evaluate(()=>fixture.getValue()),before);
  await page.screenshot({path:artifactPath('leaf-callouts.png')});
  console.log('Table caret, BR rendering, callout folding/nesting and source round-trip passed');
  assert.deepEqual(errors,[]);
} finally {await browser.close();}
