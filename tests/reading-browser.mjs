import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto((process.env.LEAF_TEST_BASE_URL || 'http://127.0.0.1:41732'));await page.click('#welcomeNewButton');
 await page.click('#commandsButton');await page.fill('#paletteInput','文档属性');await page.getByRole('option',{name:'文档属性',exact:true}).click();
 await page.getByRole('textbox',{name:'新属性名',exact:true}).waitFor();
 await page.keyboard.press('ControlOrMeta+z');
 const editIcon=await page.locator('#readingToggle').innerHTML();
 const source='---\nversion: v1\n---\n\n# 标题\n\n**重点** 和 ==高亮==\n\n| 列一 | 列二 |\n| --- | --- |\n| A<br>B | C |\n\n> [!note] 提示\n> 内容\n\n## 子标题\n\n正文\n\n### 三级\n\n#### 四级\n\n##### 五级\n\n###### 六级';
 await page.locator('.cm-content').fill(source);
 await page.click('#commandsButton');await page.fill('#paletteInput','文档属性');await page.getByRole('option',{name:'文档属性',exact:true}).click();
 assert.ok(await page.locator('.leaf-property-body').isVisible());
 const getSource=()=>page.evaluate(async()=>{
  const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
  return EditorView.findFromDOM(document.querySelector('.cm-content')).state.doc.toString();
 });
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
 assert.ok(await page.locator('#readingPane').isVisible());
 assert.notEqual(await page.locator('#readingToggle').innerHTML(),editIcon);
 assert.ok((await page.locator('#readingToggle').getAttribute('aria-label')).includes('阅读'));
 await page.click('#commandsButton');await page.fill('#paletteInput','文档属性');await page.getByRole('option',{name:'文档属性',exact:true}).click();
 assert.ok(await page.locator('.reading-document .print-properties').isVisible());
 await page.locator('#readingPane').focus();
 assert.equal(await page.locator('.reading-document h1[data-source-line]').innerText(),'标题');
 assert.equal(await page.locator('.reading-document table').count(),1);
 assert.equal(await page.locator('.reading-document .leaf-callout').count(),1);
 assert.equal(await page.locator('.reading-document mark').innerText(),'高亮');
 assert.equal(await page.locator('.reading-document h2[data-source-line]').getAttribute('data-source-line'),String(source.split('\n').indexOf('## 子标题')+1));
 await page.keyboard.type('SHOULD_NOT_EDIT');
 await page.keyboard.press('ControlOrMeta+r');
 assert.equal(await page.locator('#readingToggle').getAttribute('aria-label'),'视图模式：源码');
 await page.keyboard.press('ControlOrMeta+r');
 assert.equal(await page.locator('#readingPane').isVisible(),false);
 assert.equal(await page.locator('#readingToggle').innerHTML(),editIcon);
 assert.equal(await getSource(),source);
 await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();await page.locator('#readingToggle').click();await page.locator('.mode-popover [data-mode='+((await page.locator('#readingPane').isVisible())?'edit':'reading')+']').click();
 assert.equal(await getSource(),source);
 // Heading fonts stay identical across modes, independently of body preference.
 for (const font of ['serif','sans','mono']) {
  await page.click('#appearanceButton');
  await page.selectOption('#englishFontSelect',font);
  await page.selectOption('#chineseFontSelect',font);
  await page.waitForSelector('.shell[data-body-fonts]');
  await page.click('#settingsClose');
  const editFonts=await page.locator('.cm-line.cm-leaf-heading').evaluateAll(els=>els.map(e=>getComputedStyle(e).fontFamily));
  assert.equal(editFonts.length,6);
  await page.click('#readingToggle');await page.click('[data-mode="reading"]');
  const readingFonts=await page.locator('.reading-document :is(h1,h2,h3,h4,h5,h6)[data-source-line]').evaluateAll(els=>els.map(e=>getComputedStyle(e).fontFamily));
  assert.deepEqual(readingFonts,editFonts,`${font}: heading fonts match`);
  const bodyFont=await page.locator('.reading-document > p').first().evaluate(e=>getComputedStyle(e).fontFamily);
  if (font==='serif') assert.match(bodyFont,/Leaf Body en serif/);
  if (font==='mono') assert.match(bodyFont,/monospace/);
  if (font==='sans') assert.match(bodyFont,/Leaf Body en sans/);
  if (font!=='sans') assert.notEqual(bodyFont,readingFonts[0]);
  await page.click('#readingToggle');await page.click('[data-mode="edit"]');
  assert.equal(await getSource(),source);
 }
 await page.keyboard.press('ControlOrMeta+z');
 assert.notEqual(await getSource(),source);
 assert.deepEqual(errors,[]);
 console.log('PASS read/edit shortcuts, rendering, source preservation, undo');
} finally {await browser.close();}
