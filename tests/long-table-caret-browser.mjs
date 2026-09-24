import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const source = process.env.LEAF_TEST_DOCUMENT
  ? await readFile(process.env.LEAF_TEST_DOCUMENT, 'utf8')
  : '# 长表格回归\n\n' + '用于检查滚动和光标的公开合成段落。\n\n'.repeat(20)
    + '| 编号 | 内容 | 描述 | 链接 | 备注 |\n| --- | --- | --- | --- | --- |\n'
    + Array.from({length: 9}, (_, row) => `| ${row + 1} | 中文测试内容 | ${'可编辑长文本'.repeat(8)} | [测试链接](https://example.com/reference/${row}) | 支持连续退格与保存 |`).join('\n');
const browser = await chromium.launch(launchOptions);
try {
  const page = await browser.newPage({viewport:{width:1000,height:800}});
  await page.addInitScript(source=>{
    let content=source;
    window.showOpenFilePicker=async()=>[{
      name:'table-test.md', kind:'file',
      getFile:async()=>new File([content],'table-test.md'),
      queryPermission:async()=> 'granted', requestPermission:async()=> 'granted',
      createWritable:async()=>({write:async text=>{window.savedText=content=text},close:async()=>{}}),
    }];
  },source);
  page.on('pageerror',e=>console.log('PAGE ERROR',e.message));
  await page.goto('http://127.0.0.1:41732');
  await page.click('#welcomeOpenButton');
  const cell=page.locator('textarea[data-row="4"][data-col="3"]').first();
  // Bring the large block into CodeMirror's viewport before locating its cell.
  await page.waitForTimeout(500);
  await page.locator('.cm-scroller').evaluate(el=>el.scrollTop=1500);
  await page.waitForTimeout(300);
  await cell.locator('..').locator('.leaf-cell-preview').click();
  await cell.evaluate(el=>{window.originalCell=el;el.setSelectionRange(8,8)});
  for(let i=0;i<4;i++){
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(150);
    const actual=await page.evaluate(()=>({same:originalCell.isConnected,focus:originalCell===document.activeElement,pos:originalCell.selectionStart,active:document.activeElement.outerHTML.slice(0,150),scroll:document.querySelector('.cm-scroller').scrollTop,tables:document.querySelectorAll('.leaf-table').length}));
    console.log('Delete',i+1,actual);
    assert.ok(actual.same&&actual.focus&&actual.pos===7-i);
  }
  await page.keyboard.insertText('测试；');
  await page.waitForTimeout(1300);
  assert.equal(await cell.evaluate(el=>el===document.activeElement),true);
  assert.ok(await page.evaluate(()=>window.savedText?.includes('测试；')));
  const count=await page.locator('.leaf-table textarea').count();
  for(let n=0;n<count;n++){
    const input=page.locator('.leaf-table textarea').nth(n);
    await input.locator('..').locator('.leaf-cell-preview').click();
    const before=await input.inputValue();
    await input.evaluate(el=>{window.originalCell=el;el.setSelectionRange(Math.min(3,el.value.length),Math.min(3,el.value.length))});
    await page.keyboard.insertText('测试');
    for(let j=0;j<2;j++){
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(50);
      assert.ok(await input.evaluate(el=>el===originalCell&&el===document.activeElement),`cell ${n} lost focus`);
    }
    assert.equal(await input.inputValue(),before);
  }
  console.log(`All ${count} cells: Chinese insertion and repeated Backspace passed`);
  console.log('Long-table caret and save passed');
}finally{await browser.close()}
