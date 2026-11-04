import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium, webkit} from 'playwright';

const base = process.env.LEAF_TEST_BASE_URL || 'http://127.0.0.1:41732';
await mkdir('test-results', {recursive:true});

async function checkNoticeReachability(page) {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('leaf-image-reveal-failed', {detail:'Synthetic failure for layout regression.'})));
  await page.locator('#statusNotice').waitFor({state:'visible'});
  const geometry = await page.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    const toolbar = rect('.format-toolbar'), notice = rect('#statusNotice'), area = rect('.document-area'), close = rect('#dismissStatus');
    const controls = [...document.querySelectorAll('.format-toolbar > button')].filter(el => el.getClientRects().length);
    return {toolbarBottom:toolbar.bottom, controlsBottom:Math.max(...controls.map(el => el.getBoundingClientRect().bottom)), noticeTop:notice.top, noticeBottom:notice.bottom, areaTop:area.top,
      closeHit:document.elementFromPoint(close.x+close.width/2, close.y+close.height/2)?.closest('button')?.id};
  });
  assert.ok(geometry.controlsBottom <= geometry.toolbarBottom + 1, JSON.stringify(geometry));
  assert.ok(geometry.noticeTop >= geometry.toolbarBottom - 1 && geometry.noticeBottom <= geometry.areaTop + 1, JSON.stringify(geometry));
  assert.equal(geometry.closeHit, 'dismissStatus', JSON.stringify(geometry));
  await page.click('#dismissStatus');
  assert.ok(await page.locator('#statusNotice').isHidden());
}
for (const engine of [chromium, webkit].filter(engine => !process.env.LEAF_TITLEBAR_ENGINE || engine.name() === process.env.LEAF_TITLEBAR_ENGINE)) {
  const browser = await engine.launch({headless:true, ...(engine===chromium && process.env.LEAF_BROWSER_CHANNEL ? {channel:process.env.LEAF_BROWSER_CHANNEL} : {})});
  try {
    for (const platform of ['MacIntel', 'Win32']) {
      const page = await browser.newPage({viewport:{width:1100,height:800}});
      const errors = [];
      page.on('pageerror', error => errors.push(error.stack));
      await page.addInitScript(platform => {
        Object.defineProperty(navigator,'platform',{get:()=>platform});
        Object.defineProperty(navigator,'userAgentData',{get:()=>({platform})});
        window.isTauri = true;
        let id=0, revision=0;
        window.calls=[];
        window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'document-test'},currentWebview:{label:'document-test'}},transformCallback:()=>++id,invoke:async(command,args={})=>{
          calls.push(command);
          if(command==='language_get') return {preference:'zh-Hans',language:'zh-Hans',revision};
          if(command==='language_set') return {preference:args.preference,language:args.preference,revision:++revision};
          if(command==='initial_path') return '/samples/Inception Paper.md';
          if(command==='observe_document') return {path:'/samples/Inception Paper.md',content:'# Synthetic title\n\nSynthetic body.'};
          if(command==='read_document') return '# Synthetic title\n\nSynthetic body.';
          if(command==='recovery_list'||command==='recent_list') return [];
          if(command==='recovery_retention') return 30;
          return null;
        }};
      },platform);
      await page.goto(`${base}/?document=1`);
      await page.waitForFunction(()=>document.querySelector('#fileName')?.textContent==='Inception Paper.md');
      const content = () => page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');return EditorView.findFromDOM(document.querySelector('.cm-content')).state.doc.toString();});
      const original = await content();
      for(const language of ['zh-Hans','zh-Hant-TW','en']) {
        await page.evaluate(async language => {const {setLanguagePreference}=await import('/src/i18n.js');await setLanguagePreference(language);},language);
        const expected = platform==='MacIntel'
          ? {'zh-Hans':'在 Finder 中显示','zh-Hant-TW':'在 Finder 中顯示',en:'Show in Finder'}[language]
          : {'zh-Hans':'在文件资源管理器中显示','zh-Hant-TW':'在檔案總管中顯示',en:'Show in File Explorer'}[language];
        for(const theme of ['light','dark']) for(const width of [1100,900,720,640]) {
          await page.setViewportSize({width,height:480});
          await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.querySelector('#fileName').textContent='Long synthetic document filename with 中文 and 繁體文字.md';},theme);
          await page.waitForFunction(()=>{
            const title=document.querySelector('#documentMenuButton').getBoundingClientRect();
            return Math.abs((title.left+title.right)/2-innerWidth/2)<1;
          });
          await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
          const geometry = await page.evaluate(()=>{
            const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
            return {title:rect('#documentMenuButton'),brand:rect('.brand'),actions:rect('.topbar-actions'),stacked:document.querySelector('.shell').classList.contains('titlebar-stacked'),overflow:document.documentElement.scrollWidth>innerWidth};
          });
          const {title,brand,actions,stacked}=geometry;
          assert.ok(stacked ? title.top>=actions.bottom : title.right+11<=actions.left,JSON.stringify(geometry));
          assert.ok(stacked || title.left>=brand.right,JSON.stringify(geometry));
          if(width>=900) assert.equal(stacked,false,'desktop minimum keeps a single title row');
          assert.equal(geometry.overflow,false);
          await checkNoticeReachability(page);
          await page.click('#documentMenuButton');
          assert.equal((await page.locator('#documentReveal').innerText()).trim(),expected);
          assert.equal(await page.locator('#documentMenuButton').getAttribute('aria-expanded'),'true');
          await page.keyboard.press('Escape');
          assert.equal(await page.evaluate(()=>document.activeElement.id),'documentMenuButton');
          if(platform==='MacIntel'&&language==='zh-Hans'&&width===900) await page.screenshot({path:`test-results/titlebar-${engine.name()}-${theme}-900.png`});
        }
      }
      await page.click('#documentMenuButton');
      await page.click('#documentReveal');
      assert.equal(await page.evaluate(()=>calls.filter(c=>c==='reveal_document').length),1);
      assert.equal(await content(),original);
      assert.deepEqual(errors,[]);
      await page.close();
      console.log(`PASS ${engine.name()} ${platform}: three languages, two themes, four widths; reveal, focus and content preservation`);
    }
    // The web toolbar also has Open/Recent, so its title wraps at a wider window.
    const web = await browser.newPage({locale:'zh-CN',viewport:{width:1100,height:480}});
    await web.goto(base);
    await web.click('#welcomeNewButton');
    for (const language of ['zh-Hans','zh-Hant-TW','en']) {
      await web.evaluate(async language => (await import('/src/i18n.js')).setLanguagePreference(language), language);
      for (const theme of ['light','dark']) for (const width of [1100,900,720,640]) {
        await web.setViewportSize({width,height:480});
        await web.evaluate(theme => {document.documentElement.dataset.theme=theme;}, theme);
        await web.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await checkNoticeReachability(web);
      }
    }
    await web.close();
    console.log(`PASS ${engine.name()} web: title/toolbar wrapping keeps status text and dismissal reachable in three languages, two themes and four widths`);
  } finally { await browser.close(); }
}
