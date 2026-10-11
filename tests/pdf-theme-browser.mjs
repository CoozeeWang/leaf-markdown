import assert from 'node:assert/strict';
import { webkit } from 'playwright';
import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';

const source='# Heading 1\n\n## Heading 2\n\n### Heading 3\n\n#### Heading 4\n\n##### Heading 5\n\n###### Heading 6\n\nText **bold** *italic* `code` ==highlight== [link](https://example.com).\n\n> Quote\n\n| Name | Value |\n| --- | --- |\n| Sample | 42 |\n\n> [!note]\n> Sample note.';
const selectors=['h1','h2','h3','h4','h5','h6','p','strong','em','code','mark','a','blockquote','th','td','.leaf-callout'];
async function colors(page, root) {
 return page.locator(root).evaluate((root, selectors)=>selectors.map(selector=>{
  const css=getComputedStyle(root.querySelector(selector + ':not(.leaf-file-name-title)'));
  return [css.color,css.backgroundColor,css.borderLeftColor];
 }),selectors);
}
for (const engine of ['chrome','webkit']) {
 const browser=await (engine==='webkit'?webkit.launch({headless:true}):chromium.launch(launchOptions));
 try {
  const context=await browser.newContext({locale:'zh-CN',viewport:{width:950,height:800}});
  const editor=await context.newPage();editor.setDefaultTimeout(10000);
  await editor.goto('http://127.0.0.1:41732');await editor.click('#welcomeNewButton');
  await editor.click('#appearanceButton');await editor.selectOption('#themeSelect','light');await editor.click('#settingsClose');
  await editor.locator('.cm-content').fill(source);
  await editor.click('#readingToggle');await editor.click('[data-mode="reading"]');
  const reference=await colors(editor,'.reading-document');
  const page=await context.newPage();page.setDefaultTimeout(10000);
  await page.goto('http://127.0.0.1:41732');
  await page.evaluate(source=>sessionStorage.setItem('pdf-theme',JSON.stringify({source,name:'Sample.md',numbered:false})),source);
  await page.goto('http://127.0.0.1:41732/?export=pdf-theme');await page.locator('.print-document h1').waitFor();
  const paper=await colors(page,'.print-document');
  // Compare foreground colors; backgrounds/borders only where they are meaningful.
  paper.forEach((value,index)=>assert.equal(value[0],reference[index][0],`${engine}: ${selectors[index]} ink matches reading`));
  for(const selector of ['code','mark','blockquote','th','.leaf-callout']) {
   const i=selectors.indexOf(selector);assert.equal(paper[i][1],reference[i][1],`${selector} background`);
  }
  for(const language of ['zh-Hans','zh-Hant-TW','en']) {
   await page.evaluate(async language=>(await import('/src/i18n.js')).setLanguagePreference(language),language);
   for(const theme of ['light','dark']) {
    await editor.evaluate(theme=>localStorage.setItem('leaf-theme',theme),theme);
    await page.waitForFunction(theme=>document.documentElement.dataset.exportTheme===theme,theme);
    assert.deepEqual(await colors(page,'.print-document'),paper,'Paper never follows dark chrome');
    assert.equal(await page.locator('.print-document').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
    assert.equal(await page.locator('.export-toolbar').evaluate(e=>getComputedStyle(e).backgroundColor),theme==='dark'?'rgb(36, 40, 36)':'rgb(250, 250, 247)');
    await page.setViewportSize({width:720,height:480});
    assert.ok(await page.locator('#print').isVisible());
    assert.equal(await page.locator('#print').evaluate(el=>getComputedStyle(el).fontSize),'14px');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(language==='zh-Hans'&&theme==='dark') await page.screenshot({path:artifactPath(`pdf-theme-${engine}-dark.png`)});
   }
  }
  await editor.evaluate(()=>localStorage.setItem('leaf-theme','system'));
  await page.emulateMedia({colorScheme:'light'});await page.waitForFunction(()=>document.documentElement.dataset.exportTheme==='light');
  await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.exportTheme==='dark');
  await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('.export-toolbar').isVisible(),false);
  assert.deepEqual(await colors(page,'.print-document'),paper);
  await context.close();
  console.log(`PASS ${engine}: reading palette, fixed white paper, live/system themes, three languages, minimum width and print`);
 } finally {await browser.close();}
}
