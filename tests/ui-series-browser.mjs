import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage({viewport:{width:1280,height:850}}), errors=[];
 page.on('pageerror', e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732'); await page.click('#welcomeNewButton');
 const metrics=await page.evaluate(()=>{
   const style=s=>getComputedStyle(document.querySelector(s));
   return {button:style('#openButton').height, icon:style('#openButton svg').width,
     compact:style('#calloutButton').height, compactIcon:style('#calloutButton svg').width,
     filename:style('.filename').fontSize, status:style('.statusbar').fontSize,
     brand:style('.brand-copy strong').fontFamily};
 });
 assert.deepEqual({...metrics,brand:null},{button:'36px',icon:'18px',compact:'30px',compactIcon:'16px',filename:'13px',status:'11px',brand:null});
 assert.ok(metrics.brand.startsWith('Palatino'));
 const glyphs=await page.locator('.heading-control, .format-glyph').evaluateAll(nodes=>nodes.map(n=>{const s=getComputedStyle(n);return {family:s.fontFamily,size:s.fontSize};}));
 assert.equal(glyphs.length,6);
 assert.ok(glyphs.every(g=>g.family===glyphs[0].family && g.size==='14px'));
 await page.evaluate(async()=>{
   const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
   const view=EditorView.findFromDOM(document.querySelector('.cm-content'));
   view.dispatch({changes:{from:0,to:view.state.doc.length,insert:'# 写作，从容一点\n\n保留熟悉的阅读体验，让工具安静地陪伴文字。\n\n## 整理思路\n\n**重点清晰**，也保留 *表达的温度*。\n\n> [!note]\n> 一组统一的界面细节。'}});
 });
 await page.click('#appearanceButton');
 for (const selector of ['#fontSizeInput', '#contentWidthInput']) {
   const input=page.locator(selector);
   const look=await input.evaluate(el=>{const s=getComputedStyle(el);return {appearance:s.webkitAppearance,shadow:s.boxShadow,height:s.height};});
   assert.deepEqual(look,{appearance:'none',shadow:'none',height:'24px'});
   const before=Number(await input.inputValue());
   const step=Number(await input.getAttribute('step'));
   await input.focus(); await input.press('ArrowRight');
   assert.equal(Number(await input.inputValue()),before+step);
   await input.press('ArrowLeft'); assert.equal(Number(await input.inputValue()),before);
 }
 for (const selector of ['#themeSelect', '#fontFamilySelect']) {
   const look=await page.locator(selector).evaluate(el=>{const s=getComputedStyle(el);return {appearance:s.webkitAppearance,shadow:s.boxShadow,image:s.backgroundImage,height:s.height};});
   assert.deepEqual(look,{appearance:'none',shadow:'none',image:'none',height:'36px'});
 }
 assert.equal(await page.locator('#appearancePopover h2').evaluate(el=>getComputedStyle(el).fontSize),'18px');
 await page.screenshot({path:artifactPath('leaf-series-light.png')});
 await page.click('#settingsTab-appearance');await page.selectOption('#themeSelect','dark');
 await page.waitForTimeout(250);
 await page.screenshot({path:artifactPath('leaf-series-dark.png')});
 await page.click('#appearanceButton'); await page.hover('#readingToggle'); await page.waitForTimeout(400);
 assert.ok(await page.locator('#tooltip').isVisible());
 assert.equal(await page.locator('#tooltip').evaluate(el=>getComputedStyle(el).fontSize),'12px');
 await page.click('#searchButton');
 await page.locator('.cm-search button[name="close"] svg').waitFor();
 assert.equal(await page.locator('.cm-search button[data-series-icon]').count(),4);
 await page.locator('.cm-search input[name="search"]').fill('文字');
 await page.locator('.cm-search button[name="close"]').click();
 for(const width of [900,720]) {
   await page.setViewportSize({width,height:650});
   assert.ok(await page.locator('#commandsButton').evaluate(el=>el.getBoundingClientRect().right<=innerWidth));
 }
 await page.screenshot({path:artifactPath('leaf-series-narrow.png')});
 assert.deepEqual(errors,[]);
 console.log('PASS series typography, icon/control sizes, settings, tooltip, dark and narrow UI');
} finally {await browser.close();}
