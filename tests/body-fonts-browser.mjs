import assert from 'node:assert/strict';
import { webkit } from 'playwright';
import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
const base = process.env.LEAF_TEST_BASE_URL || 'http://127.0.0.1:41732';
const sample = '# Font sample 字体\n\nCafé e\u0301 ma\u0304. 123\n\n写作，从容一点。\n\nMixed 中文 “引号” English 123. **Bold 粗体** and *italic 斜体*. Missing glyph: 🦊\n\n`code 代码`\n\n| English | 中文 |\n| --- | --- |\n| Body | 内容 |\n\nText[^note].\n\n[^note]: Note 注释';
const sourceState = page => page.evaluate(async () => {
  const {EditorView} = await import('/node_modules/@codemirror/view/dist/index.js');
  const {undoDepth} = await import('/node_modules/@codemirror/commands/dist/index.js');
  const view = EditorView.findFromDOM(document.querySelector('#editor > .cm-editor'));
  return { source: view.state.doc.toString(), undo: undoDepth(view.state) };
});
const mode = async (page, value) => { await page.click('#readingToggle'); await page.click(`[data-mode="${value}"]`); };
const ready = page => page.waitForSelector('.shell[data-body-fonts="ready"]');
const openSettings = async page => { if (await page.locator('#appearancePopover').isHidden()) await page.click('#appearanceButton'); };
const pick = async (page, control, id) => {
  await page.click(`${control}Button`);
  let option = page.locator(`${control}List [data-font-id="${id}"]`);
  if (!await option.count()) {
    // Legacy presets are intentionally shown under the actual family's name/id.
    const family = await page.evaluate(async ({control,id}) => {
      const {loadBodyFonts}=await import('/src/body-fonts.js');
      return (await loadBodyFonts())[control.includes('english')?'en':'zh'][id]?.family;
    },{control,id});
    const fonts = page.locator(`${control}List [role="option"]`);
    const index = await fonts.evaluateAll((elements,family)=>elements.findIndex(el=>el.style.fontFamily.includes(family)),family);
    assert.ok(index>=0,`No displayed family for ${id}`); option=fonts.nth(index);
  }
  await option.click();
};

for (const engine of process.env.LEAF_TEST_ENGINE ? [process.env.LEAF_TEST_ENGINE] : ['chrome','webkit']) {
  const browser = await (engine === 'webkit' ? webkit.launch({headless:true}) : chromium.launch(launchOptions));
  try {
    for (const preset of ['sans','serif','mono']) {
      const page = await browser.newPage({locale:'en-US'});
      await page.addInitScript(preset => localStorage.setItem('leaf-reading-v2-font',preset),preset);
      await page.goto(base); await ready(page);
      assert.equal(await page.locator('#englishFontSelect').inputValue(),preset);
      assert.equal(await page.locator('#chineseFontSelect').inputValue(),preset);
      assert.equal(await page.evaluate(()=>localStorage.getItem('leaf-body-fonts-v1')),null,'Migration does not rewrite preferences before user changes them');
      await page.close();
    }
    // On older macOS, bundled WebKit can crash in AppKit when resizing a focused
    // editable document. Start narrow there; Chromium covers the live resize.
    const context = await browser.newContext({locale:'en-US',viewport:engine==='webkit'?{width:720,height:480}:{width:1100,height:800}});
    const page = await context.newPage(), errors=[], fontRequests=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(request.resourceType()==='font')fontRequests.push(request.url());});
    await page.goto(base); await ready(page); await page.click('#welcomeNewButton');
    await page.locator('.editor-host .cm-content').fill(sample);
    const before=await sourceState(page);
    const uiFont=await page.locator('.cm-line.cm-leaf-heading').evaluate(el=>getComputedStyle(el).fontFamily);
    const codeFont=await page.locator('.cm-leaf-inline-code').evaluate(el=>getComputedStyle(el).fontFamily);
    const choose=async (script,candidates)=>{
      for(const id of candidates) if(!await page.locator(`#${script}FontSelect option[value="${id}"]`).evaluate(option=>option.disabled)) {
        await pick(page,`#${script}FontSelect`,id); return page.locator(`#${script}FontSelect`).inputValue();
      }
      throw new Error('No usable body preset');
    };
    await openSettings(page);
    const english=await choose('english',['georgia','palatino','serif']);
    const chinese=await choose('chinese',['songti','pingfang','serif']);
    await page.click('#englishFontSelectButton');
    const options=page.locator('#englishFontSelectList [role="option"]');
    const families=await options.evaluateAll(els=>els.map(el=>el.style.fontFamily));
    assert.equal(new Set(families).size,families.length,'Actual font families appear only once');
    assert.ok(!(await options.allTextContents()).some(text=>/System|Unavailable/.test(text)));
    const unchanged=await page.evaluate(()=>localStorage.getItem('leaf-body-fonts-v1'));
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>localStorage.getItem('leaf-body-fonts-v1')),unchanged,'Navigation/cancel does not commit');
    assert.equal(await page.locator('#appearancePopover').isVisible(),true,'Escape closes only the font list');
    await page.locator('#englishFontSelectButton').press('Enter');
    await page.keyboard.press('Home'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#englishFontSelectButton').getAttribute('aria-expanded'),'false');
    await pick(page,'#englishFontSelect',english);
    await page.click('#englishFontSelectButton');
    await page.keyboard.press('g'); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#englishFontSelect').inputValue(),'georgia','Typing a prefix selects the named family');
    await pick(page,'#englishFontSelect',english);
    const stack=await page.locator('#editor > .cm-editor > .cm-scroller').evaluate(el=>getComputedStyle(el).fontFamily);
    assert.ok(stack.includes(`Leaf Body en ${english}`));
    assert.ok(stack.includes(`Leaf Body zh ${chinese}`));
    assert.deepEqual(await sourceState(page),before,'Font choices do not edit Markdown or create undo entries');
    assert.equal(await page.locator('.cm-line.cm-leaf-heading').evaluate(el=>getComputedStyle(el).fontFamily),uiFont);
    assert.equal(await page.locator('.cm-leaf-inline-code').evaluate(el=>getComputedStyle(el).fontFamily),codeFont,'Inline code keeps its independent monospace stack');
    // Chromium reports the actual fonts used for glyphs, beyond the declared CSS stack.
    if(engine==='chrome') {
      await page.evaluate(()=>{
        for (const [script,text] of [['en','Café e\u0301 ma\u0304. 123'],['zh','写作，从容一点。']]) {
          const line=[...document.querySelectorAll('.cm-line')].find(el=>el.textContent===text);
          if(!line)throw new Error('Missing script glyph fixture'); line.id=`font-proof-${script}`;
        }
      });
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const cdp=await context.newCDPSession(page);
      await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
      await page.click('#englishFontSelectButton');
      const menuRoot=await cdp.send('DOM.getDocument');
      const menuNode=await cdp.send('DOM.querySelector',{nodeId:menuRoot.root.nodeId,selector:`#englishFontSelectOption-${english}`});
      const menuFonts=await cdp.send('CSS.getPlatformFontsForNode',{nodeId:menuNode.nodeId});
      assert.ok(menuFonts.fonts.some(font=>new RegExp(english==='georgia'?'Georgia':'Palatino','i').test(font.familyName)&&font.glyphCount>0),'The visible font name itself uses the selected family');
      await page.keyboard.press('Escape');
      // Decomposed accents must remain with their Latin base, not the CJK font.
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const {root}=await cdp.send('DOM.getDocument');
      for(const [script,selector] of [['en','#font-proof-en'],['zh','#font-proof-zh']]) {
        const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector});
        const {fonts}=await cdp.send('CSS.getPlatformFontsForNode',{nodeId});
        const expected=script==='en' ? {georgia:/Georgia/i,palatino:/Palatino/i,serif:/Georgia|Times|Liberation Serif/i}[english] : {songti:/Songti/i,pingfang:/PingFang/i,simsun:/SimSun|宋体/i,yahei:/Microsoft YaHei|微软雅黑/i,serif:/Songti|SimSun|Noto Serif/i}[chinese];
        assert.ok(fonts.some(font=>expected.test(font.familyName) && font.glyphCount>0),`${script}: requested local font renders glyphs: ${JSON.stringify(fonts)}`);
        if(script==='en') assert.ok(fonts.every(font=>expected.test(font.familyName)),`Combining Latin accents stay in the chosen English family: ${JSON.stringify(fonts)}`);
        console.log(`${engine} actual ${script} fonts: ${fonts.map(font=>font.familyName).join(', ')}`);
      }
      await cdp.detach();
    }
    const loaded=await page.evaluate(()=>Array.from(document.fonts).filter(face=>face.family.includes('Leaf Body')).map(face=>({family:face.family.replace(/^(["'])(.*)\1$/,'$2'),style:face.style,weight:face.weight,range:face.unicodeRange,status:face.status})));
    assert.ok(loaded.some(face=>face.family===`Leaf Body en ${english}`&&face.style==='italic'&&face.status==='loaded'),`${engine}/${english}: real italic face is loaded: ${JSON.stringify(loaded)}`);
    assert.ok(loaded.some(face=>face.family===`Leaf Body en ${english}`&&face.weight==='700'&&face.status==='loaded'),`${engine}/${english}: real bold face is loaded: ${JSON.stringify(loaded)}`);
    await page.click('#settingsClose'); await mode(page,'reading');
    assert.equal(await page.locator('.reading-document > p').first().evaluate(el=>getComputedStyle(el).fontFamily),stack);
    assert.equal(await page.locator('.reading-document h1[data-source-line]').evaluate(el=>getComputedStyle(el).fontFamily),uiFont);
    assert.ok(await page.locator('.reading-document em').count());
    assert.ok(await page.locator('.reading-document strong').count());
    await mode(page,'source');
    assert.match(await page.locator('.editor-host .cm-content').evaluate(el=>getComputedStyle(el).fontFamily),/monospace/);
    assert.deepEqual(await sourceState(page),before);
    await mode(page,'edit');
    const sibling=await context.newPage(); await sibling.goto(base); await ready(sibling);
    await openSettings(page); await pick(page,'#englishFontSelect','mono');
    await sibling.waitForFunction(()=>document.querySelector('#englishFontSelect').value==='mono');
    assert.equal(await sibling.locator('#chineseFontSelect').inputValue(),chinese,'English changes preserve the independent Chinese choice in the other window');
    await pick(page,'#englishFontSelect',english); await sibling.close();
    // Read latest persisted values when another window's storage event has not arrived yet.
    await page.evaluate(()=>localStorage.setItem('leaf-body-fonts-v1',JSON.stringify({zh:'mono',en:'sans'})));
    await pick(page,'#englishFontSelect',english);
    assert.equal(await page.locator('#chineseFontSelect').inputValue(),'mono');
    await pick(page,'#chineseFontSelect',chinese);
    const saved=await page.evaluate(()=>localStorage.getItem('leaf-body-fonts-v1'));
    await page.reload(); await ready(page);
    assert.deepEqual(JSON.parse(saved),{zh:chinese,en:english});
    assert.equal(await page.locator('#chineseFontSelect').inputValue(),chinese);
    assert.equal(await page.locator('#englishFontSelect').inputValue(),english);
    await page.click('#welcomeNewButton'); await page.locator('.editor-host .cm-content').fill(sample);
    for(const [language,label] of [['zh-Hans','东亚字体'],['zh-Hant-TW','東亞字型'],['en','East Asian font']]) {
      await page.click('#editorLanguageSelect'); await page.click(`[data-language="${language}"]`);
      await page.waitForFunction(language=>document.documentElement.lang===language,language);
      await openSettings(page);
      assert.equal(await page.getByRole('combobox',{name:label,exact:true}).count(),1);
      assert.equal(await page.locator('.body-font-preview').count(),0);
      assert.equal(await page.locator('#chineseFontSelect').inputValue(),chinese);
      for(const theme of ['light','dark']) {
        await openSettings(page);
        await page.locator('#themeSelect').scrollIntoViewIfNeeded();
        await page.selectOption('#themeSelect',theme);
        if(engine!=='webkit') await page.setViewportSize({width:720,height:480});
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        await openSettings(page);
        const geometry=await page.locator('.appearance-scroll').evaluate(el=>({overflow:el.scrollWidth>el.clientWidth, right:el.getBoundingClientRect().right}));
        assert.ok(!geometry.overflow&&geometry.right<=720);
        await page.locator('#chineseFontSelectButton').scrollIntoViewIfNeeded();
        await page.click('#chineseFontSelectButton');
        const menu=await page.locator('#chineseFontSelectList').boundingBox();
        assert.ok(menu && menu.x>=0 && menu.y>=0 && menu.x+menu.width<=720 && menu.y+menu.height<=480,'Font menu stays inside the narrow viewport');
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('#chineseFontSelectButton').getAttribute('aria-expanded'),'false','Tab dismisses the list');
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        assert.equal(await page.locator('#appearancePopover').isVisible(),true,'Tab keeps the settings panel open');
        await page.screenshot({path:artifactPath(`fonts-${engine}-${language}-${theme}.png`)});
      }
      await page.click('#settingsClose');
    }
    await openSettings(page);
    const stored=await page.evaluate(()=>localStorage.getItem('leaf-body-fonts-v1'));
    await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='leaf-body-fonts-v1')throw new Error('Storage unavailable');return original.call(this,key,value);};});
    await pick(page,'#englishFontSelect','sans');
    assert.equal(await page.locator('#englishFontSelect').inputValue(),english);
    assert.match(await page.locator('#bodyFontStatus').innerText(),/Could not save/);
    assert.equal(await page.evaluate(()=>localStorage.getItem('leaf-body-fonts-v1')),stored);
    assert.deepEqual(errors,[]); assert.deepEqual(fontRequests,[],'Local font selections never fetch font files');
    await context.close();
    // Simulate uninstalling a previously selected font, with real fallback rendering.
    const missing=await browser.newPage({locale:'en-US'});
    await missing.addInitScript(()=>{
      localStorage.setItem('leaf-body-fonts-v1',JSON.stringify({zh:'sans',en:'georgia'}));
      const Native=FontFace;
      window.FontFace=class extends Native {
        constructor(family,source,descriptors){super(family,source,descriptors);this.blocked=source.includes('Georgia');}
        load(){return this.blocked?Promise.reject(new Error('Font removed')):super.load();}
      };
    });
    await missing.goto(base); await ready(missing);
    assert.equal(await missing.locator('#englishFontSelect').inputValue(),'georgia');
    assert.equal(await missing.locator('#englishFontSelect option[value="georgia"]').evaluate(option=>option.disabled),true);
    assert.match(await missing.locator('#bodyFontStatus').innerText(),/Georgia is unavailable\. Using (Arial|SF Pro Text|Segoe UI|Liberation Sans)/);
    assert.match(await missing.locator('.shell').evaluate(el=>el.style.getPropertyValue('--body-font')),/en sans/);
    assert.equal(await missing.evaluate(()=>JSON.parse(localStorage.getItem('leaf-body-fonts-v1')).en),'georgia','Missing requested choice is retained for later reinstallation');
    await missing.close();
    console.log(`PASS ${engine}: independent script fonts, migration, real faces, fallback, persistence, windows, undo and three-language layout`);
  } finally { await browser.close(); }
}
