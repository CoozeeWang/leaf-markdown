import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 for(const platform of ['MacIntel','Win32']) {
  const page=await browser.newPage();
  await page.addInitScript(platform=>{Object.defineProperty(navigator,'platform',{get:()=>platform});Object.defineProperty(navigator,'userAgentData',{get:()=>undefined});},platform);
  await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
  assert.equal(await page.locator('#propertiesButton').count(),0);
  const key=platform==='MacIntel'?'⌘':'Ctrl+';
  assert.equal(await page.locator('#commandsButton').textContent(),'');
  assert.equal(await page.locator('#commandsButton svg').count(),1);
  assert.equal(await page.locator('#commandsButton').getAttribute('data-tooltip'),`命令面板  ${key}P`);
  assert.equal(await page.locator('#readingToggle').getAttribute('data-tooltip'),`选择编辑、源码或阅读模式  ${key}R`);
  await page.keyboard.press(platform==='MacIntel'?'Meta+r':'Control+r');
  assert.equal(await page.locator('#readingToggle').getAttribute('data-tooltip'),`选择编辑、源码或阅读模式  ${key}R`);
  assert.equal(await page.locator('#undoButton').getAttribute('data-tooltip'),`撤销  ${key}Z`);
  assert.equal(await page.locator('#redoButton').getAttribute('data-tooltip'),`重做  ${platform==='MacIntel'?'⇧⌘Z':'Ctrl+Shift+Z'}`);
  assert.equal(await page.locator('#readingToggle').getAttribute('aria-label'),'视图模式：阅读');
  await page.keyboard.press(platform==='MacIntel'?'Meta+r':'Control+r');
  assert.equal(await page.locator('#readingToggle').getAttribute('aria-label'),'视图模式：源码');
  await page.keyboard.press(platform==='MacIntel'?'Meta+r':'Control+r');
  assert.equal(await page.locator('#readingToggle').getAttribute('aria-label'),'视图模式：编辑');
  await page.evaluate(()=>window.open=()=>{window.exportCount=(window.exportCount||0)+1;return {};});
  await page.keyboard.press(platform==='MacIntel'?'Meta+e':'Control+e');
  assert.equal(await page.evaluate(()=>window.exportCount),1);
  await page.click('#searchButton');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.cm-search button[name=next]').getAttribute('data-tooltip'),`下一处  ${key}G`);
  const labels=await page.locator('[data-tooltip]').evaluateAll(nodes=>nodes.map(n=>n.dataset.tooltip).join('\n'));
  if(platform==='MacIntel')assert.ok(!labels.includes('Ctrl+'));else assert.ok(!/[⌘⌥⇧]/.test(labels));
  await page.click('#commandsButton');
  const shortcut=page.locator('.palette-list button').filter({hasText:'导出 PDF'}).locator('kbd');
  const undoCommand=page.locator('.palette-list button').filter({hasText:'撤销'}).locator('kbd');
  if(platform==='MacIntel') assert.equal(await undoCommand.locator('svg').count(),1);
  else assert.equal(await undoCommand.innerText(),'Ctrl+Z');
  if(platform==='MacIntel') {
    assert.equal(await shortcut.locator('svg').count(),1);
    assert.equal(await shortcut.locator('.shortcut-keys').getAttribute('aria-label'),'Command+E');
    const sizes=await shortcut.locator('svg').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().height));
    assert.deepEqual(sizes,[12]);
    await page.screenshot({path:artifactPath('leaf-shortcuts-mac.png')});
    await page.locator('#paletteInput').press('Escape');
    await page.hover('#readingToggle'); await page.waitForTimeout(400);
    const command=page.locator('#tooltip svg[data-modifier="Command"]');
    assert.equal(await command.evaluate(el=>el.getBoundingClientRect().height),12);
  } else {
    assert.equal(await shortcut.innerText(),'Ctrl+E');
    assert.equal(await shortcut.locator('svg').count(),0);
  }
  if(platform==='MacIntel') {
    const rendered=await page.evaluate(async()=>{const {renderShortcutText}=await import('/src/platform-shortcuts.js');return ['⌥⌘,','⌘.','⌘E'].map(text=>{const el=document.createElement('span');renderShortcutText(el,text);return {count:el.querySelectorAll('svg').length,label:el.querySelector('[role=img]').getAttribute('aria-label')};});});
    assert.deepEqual(rendered,[{count:2,label:'Option+Command+,'},{count:1,label:'Command+.'},{count:1,label:'Command+E'}]);
  }
  await page.close();
 }
 console.log('PASS Mac/Windows toolbar, mode and search shortcut labels');
}finally{await browser.close()}
