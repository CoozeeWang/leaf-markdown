import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import { webkit } from 'playwright';
for (const [engine, options] of [[chromium, launchOptions], [webkit, {headless: true}]]) {
const browser = await engine.launch(options);
try {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.goto('http://127.0.0.1:41732');
  await page.locator('#welcomeNewButton').waitFor();
  const chooseQuickLanguage = async (target, id, value) => {
    await target.click(id);
    assert.ok(await target.locator('#languagePopover').isVisible(), 'First click opens the language menu');
    assert.equal(await target.locator(id).getAttribute('aria-expanded'), 'true');
    await target.click(`#languagePopover [data-language="${value}"]`);
    await target.waitForFunction(() => !document.querySelector('#editorLanguageSelect').disabled);
    assert.ok(await target.locator('#languagePopover').isHidden());
  };
  const language = async value => {
    const id = await page.locator('#welcomeScreen').isVisible() ? '#welcomeLanguageSelect' : '#editorLanguageSelect';
    await chooseQuickLanguage(page, id, value);
    await page.waitForFunction(value => document.querySelector('#editorLanguageSelect').value === value && !document.querySelector('#editorLanguageSelect').disabled, value);
  };
  // macOS WebKit uses Option-Tab to include buttons when full keyboard access is off.
  await page.locator('#welcomeRecentButton').focus(); await page.keyboard.press(engine.name() === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'welcomeLanguageSelect');
  assert.ok(await page.locator('#welcomeLanguageSelect').evaluate(el => el.matches(':focus-visible')));

  const checkClicks = async id => {
    for (const position of [{x:3,y:3}, undefined, {x:20,y:20}]) {
      await page.locator(id).click(position ? {position} : {});
      assert.ok(await page.locator('#languagePopover').isVisible(), 'A single pointer click opens the menu');
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement.id), id.slice(1));
      await page.locator(id).click(); await page.locator(id).click();
      assert.ok(await page.locator('#languagePopover').isHidden(), 'Second click closes without reopening');
    }
    await page.locator(id).click();
    assert.ok(await page.locator('#languagePopover').evaluate(el => {const r=el.getBoundingClientRect();return r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight;}));
    await page.mouse.click(5, (await page.evaluate(() => innerHeight)) - 1);
    assert.ok(await page.locator('#languagePopover').isHidden(), 'Clicking outside dismisses the menu');
    await page.locator(id).focus(); await page.keyboard.press('Enter');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.language), 'en');
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.language), 'system');
    await page.keyboard.press('Escape');
  };
  await checkClicks('#welcomeLanguageSelect');
  await page.click('#welcomeLanguageSelect');
  await page.screenshot({path:artifactPath(`i18n-language-menu-welcome-${engine.name()}.png`)});
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-Hans');
  await page.screenshot({path:artifactPath('i18n-language-welcome.png')});
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('leaf-image-reveal-failed', {detail: 'Synthetic system diagnosis'})));
  await page.waitForFunction(() => document.querySelector('#statusAnnouncement').textContent.length > 0);
  await language('en');
  assert.equal(await page.locator('#statusAnnouncement').textContent(), '', 'Old-language announcements are cleared without repeating a past action');
  assert.match(await page.locator('#saveStatus').textContent(), /Synthetic system diagnosis/, 'Persistent errors survive the language switch');
  assert.match(await page.locator('#saveStatus').textContent(), /Could not/);
  await page.click('#dismissStatus');
  assert.equal(await page.locator('#welcomeNewButton').innerText(), 'New Document');
  await page.click('#welcomeNewButton');
  await page.evaluate(async () => {
    const { EditorView } = await import('/node_modules/@codemirror/view/dist/index.js');
    window.view = EditorView.findFromDOM(document.querySelector('.cm-content'));
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '# 文档原名\n\n未保存正文。\n\n> [!note]\n> 用户内容\n\n[^1]: 注释内容\n' }, selection: { anchor: 10, head: 12 } });
  });
  const before = await page.evaluate(async () => {
    const { undoDepth, redoDepth } = await import('/node_modules/@codemirror/commands/dist/index.js');
    return { text: view.state.doc.toString(), selection: view.state.selection.toJSON(), undo: undoDepth(view.state), redo: redoDepth(view.state) };
  });
  for (const value of ['zh-Hant-TW', 'zh-Hans', 'en']) {
    await language(value);
    for (const id of ['editorLanguageSelect', 'welcomeLanguageSelect']) assert.equal(await page.locator('#'+id).evaluate(el => el.value), value);
    const after = await page.evaluate(async () => {
      const { undoDepth, redoDepth } = await import('/node_modules/@codemirror/commands/dist/index.js');
      return { text: view.state.doc.toString(), selection: view.state.selection.toJSON(), undo: undoDepth(view.state), redo: redoDepth(view.state) };
    });
    assert.deepEqual(after, before, 'Switching keeps document, selection and history');
    for(const [id,key] of [['imageInsert','writing_tools.insert_image'],['attachmentInsert','writing_tools.insert_attachment'],['linkInsert','writing_tools.insert_or_edit_link']])assert.equal(await page.locator('#'+id).getAttribute('aria-label'),await page.evaluate(async key=>(await import('/src/i18n.js')).t(key),key));
    assert.equal(await page.locator('#fileName').textContent(), 'Untitled.md', 'An existing name is retained');
  }
  await page.setViewportSize({width:900,height:480});
  await checkClicks('#editorLanguageSelect');
  await page.click('#editorLanguageSelect');
  await page.screenshot({path:artifactPath(`i18n-language-menu-editor-${engine.name()}.png`)});
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:900,height:480});
  await page.screenshot({path:artifactPath('i18n-language-editor-minimum.png')});
  await page.locator('#appearanceButton').focus(); await page.keyboard.press(engine.name() === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'editorLanguageSelect');
  assert.ok(await page.locator('#editorLanguageSelect').evaluate(el => el.matches(':focus-visible')));
  assert.equal(await page.locator('#languageSelect').count(), 0);
  await language('zh-Hant-TW');
  await page.click('#appearanceButton');
  await page.waitForFunction(() => document.documentElement.lang === 'zh-Hant-TW');
  assert.equal(await page.locator('#settingsTab-appearance').innerText(), '外觀與排版');
  await page.click('#settingsClose');
  // Search remains usable with names from every language.
  await page.click('#commandsButton');
  for (const query of ['撤销', '還原', 'Undo']) {
    await page.fill('#paletteInput', query);
    assert.ok(await page.locator('#paletteList button').count());
  }
  await page.press('#paletteInput', 'Escape');
  await page.click('#searchButton');
  await page.fill('.leaf-search input[name=search]', '用户');
  await page.click('.leaf-search button[name=toggleReplace]');
  await page.fill('.leaf-search input[name=replace]', '保留');
  await language('en');
  assert.equal(await page.locator('.leaf-search input[name=search]').inputValue(), '用户');
  assert.equal(await page.locator('.leaf-search input[name=replace]').inputValue(), '保留');
  assert.equal(await page.locator('.leaf-search input[name=search]').getAttribute('placeholder'), 'Find');
  // IME delays UI refresh until the composition completes.
  await page.evaluate(() => document.querySelector('.cm-content').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await language('zh-Hant-TW');
  assert.equal(await page.locator('.leaf-search input[name=search]').getAttribute('placeholder'), 'Find');
  await page.evaluate(() => document.querySelector('.cm-content').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  assert.equal(await page.locator('.leaf-search input[name=search]').getAttribute('placeholder'), '尋找');
  // A failed preference write keeps the selected language and reports failure.
  await page.evaluate(() => { window.originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === 'leaf-language') throw Error('synthetic failure'); return originalSetItem.call(this, key, value); }; });
  await chooseQuickLanguage(page, '#editorLanguageSelect', 'en');
  await page.waitForFunction(() => !document.querySelector('#editorLanguageSelect').disabled);
  for (const id of ['editorLanguageSelect', 'welcomeLanguageSelect']) assert.equal(await page.locator('#'+id).evaluate(el => el.value), 'zh-Hant-TW');
  assert.match(await page.locator('#saveStatus').innerText(), /語言/);
  await page.evaluate(() => { Storage.prototype.setItem = originalSetItem; });
  const other = await context.newPage(); await other.goto('http://127.0.0.1:41732'); await other.locator('#welcomeNewButton').waitFor();
  await language('en');
  await other.waitForFunction(() => document.documentElement.lang === 'en');
  await other.reload(); await other.locator('#welcomeNewButton').waitFor();
  assert.equal(await other.locator('html').getAttribute('lang'), 'en');
  assert.equal(await other.locator('#welcomeLanguageSelect').evaluate(el => el.value), 'en');
  for (const value of ['zh-Hans','zh-Hant-TW','en']) {
    await chooseQuickLanguage(other, '#welcomeLanguageSelect', value);
    await other.waitForFunction(value => document.documentElement.lang === value,value);
    for (const theme of ['light','dark']) {
      await other.setViewportSize({width:900,height:480});
      await other.evaluate(theme => { document.documentElement.dataset.theme = theme; },theme);
      assert.ok(await other.locator('#welcomeLanguageSelect').evaluate(el => { const r=el.getBoundingClientRect(), recent=document.querySelector('#welcomeRecentButton').getBoundingClientRect(); return r.left >= recent.right && r.right <= innerWidth && r.bottom <= innerHeight && r.width >= 40 && r.width === 44; }));
    }
  }
  await chooseQuickLanguage(other, '#welcomeLanguageSelect', 'system');
  await page.waitForFunction(() => document.querySelector('#editorLanguageSelect').value === 'system');
  assert.equal(await other.locator('#welcomeLanguageSelect').evaluate(el=>el.value),'system');

  await page.click('.leaf-search button[name=close]');
  for (const value of ['zh-Hans','zh-Hant-TW','en']) {
    await language(value);
    for (const theme of ['light','dark']) for (const size of [{width:1280,height:900},{width:900,height:480}]) {
      await page.setViewportSize(size);
      await page.click('#appearanceButton'); await page.selectOption('#themeSelect', theme);
      assert.ok(await page.locator('#themeSelect').evaluate(el => { const r=el.getBoundingClientRect(); return r.right <= innerWidth && r.bottom <= innerHeight; }));
      assert.ok(await page.locator('#editorLanguageSelect').evaluate(el => { const r=el.getBoundingClientRect(), settings=document.querySelector('#appearanceButton').getBoundingClientRect(); return r.left >= settings.right && r.right <= innerWidth && r.bottom <= innerHeight && r.width >= 28; }));
      await page.screenshot({ path: artifactPath(`i18n-${value}-${theme}-${size.width}.png`) });
      await page.click('#settingsClose');
    }
  }
  // Deliberately longer UI copy must leave the language control reachable.
  await language('en');await page.setViewportSize({width:900,height:480});
  await page.click('#appearanceButton');
  await page.evaluate(async()=>{
    const i18n=await import('/src/i18n.js');window.originalLanguageCopy=i18n.resources.en['settings.language'];
    i18n.resources.en['settings.language']='Interface language with a deliberately longer label';i18n.refreshTranslations();
  });
  assert.equal(await page.locator('#editorLanguageSelect').getAttribute('aria-label'), 'Interface language with a deliberately longer label');
  assert.ok(await page.locator('#themeSelect').evaluate(el=>{const r=el.getBoundingClientRect();return r.right<=innerWidth&&r.bottom<=innerHeight;}));
  await page.screenshot({path:artifactPath('i18n-long-copy-small.png')});
  await page.evaluate(async()=>{const i18n=await import('/src/i18n.js');i18n.resources.en['settings.language']=originalLanguageCopy;i18n.refreshTranslations();});
  await page.click('#settingsClose');
  // The export window follows preferences while retaining its frozen source and options.
  const exportPage = await context.newPage();
  await exportPage.goto('http://127.0.0.1:41732');
  await exportPage.evaluate(() => sessionStorage.setItem('i18n-export-fixture', JSON.stringify({source:'---\ntitle: User title\n---\n# User heading\n\n> [!note]\n> User body\n',name:'User filename.md',numbered:false})));
  await exportPage.goto('http://127.0.0.1:41732/?export=i18n-export-fixture');
  await exportPage.locator('#print').waitFor();
  await exportPage.check('#properties'); await exportPage.check('#numbered');
  await exportPage.setViewportSize({width:720,height:480});
  for (const value of ['zh-Hans','zh-Hant-TW','en']) {
    await language(value); await exportPage.waitForFunction(value => document.documentElement.lang === value, value);
    assert.equal(await exportPage.title(), 'User filename');
    assert.ok(await exportPage.locator('#properties').isChecked());assert.ok(await exportPage.locator('#numbered').isChecked());
    assert.match(await exportPage.locator('article').innerText(), /User body/);
    assert.ok(await exportPage.locator('#print').evaluate(el => {const r=el.getBoundingClientRect();return r.right<=innerWidth&&r.bottom<=innerHeight;}));
  }
  assert.equal(await exportPage.locator('.export-toolbar strong').innerText(), 'Export PDF');
  await exportPage.screenshot({path:artifactPath('i18n-export-en-small.png')});
  assert.deepEqual(errors, []);
  console.log(engine.name() + ' PASS: pointer opening/closing, keyboard menu, trilingual selection, history, aliases, IME, persistence failure, cross-window/reload and minimum-window controls');
} finally { await browser.close(); }

}
