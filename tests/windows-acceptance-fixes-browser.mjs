import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
const engine = process.env.LEAF_FIX_ENGINE === 'webkit' ? webkit : chromium;
const browser = await engine.launch({headless:true,...(engine===chromium&&process.env.LEAF_BROWSER_CHANNEL?{channel:process.env.LEAF_BROWSER_CHANNEL}:{})});
try {
 const page=await browser.newPage({locale:'zh-CN'});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');
 // The renderer used by both reading and PDF must preserve all parsed code
 // fragments, while omitting syntax-only continuation quote marks.
 await page.evaluate(async()=>{
  const {renderPrintDocument}=await import('/src/print-document.js');
  const target=document.createElement('article');
  renderPrintDocument(target,'    FIRST\n    > SECOND\n\n> QUOTE-A\n> QUOTE-B\n\n```\n> LITERAL\n```',{fallbackTitle:false});
  window.renderedRegression=target.innerHTML;
  const {waitForImages}=await import('/src/resources.js');
  const missing=document.createElement('img');missing.dataset.resource='missing.png';missing.dataset.failure='missing';missing.dataset.loaded='no';target.append(missing);
  await waitForImages(target,{allowPlaceholders:true});
 });
 const html=await page.evaluate(()=>window.renderedRegression);
 assert.ok(html.includes('&gt; SECOND'),html);
 assert.ok(html.includes('QUOTE-A\nQUOTE-B'),html);
 assert.ok(!html.includes('QUOTE-A\n&gt; QUOTE-B'),html);
 assert.ok(html.includes('&gt; LITERAL'),html);
 // Exercise real structured fields with the same source-range commits as the
 // editor. Esc must leave source untouched, blur/Enter must commit once.
 await page.evaluate(async()=>{
  const {renderProperties}=await import('/src/properties-ui.js');
  const {frontmatter}=await import('/src/markdown-model.js');
  const body=document.createElement('div');body.id='propertyRegression';document.body.append(body);
  let source='---\ntext: original\nnumber: 41.25\nitems: [one, two]\nchoice: first\n---\n\nKEEP';
  localStorage.setItem('leaf-property-types',JSON.stringify({choice:{type:'enum',options:['first','second']}}));
  window.propertySource=()=>source;
  renderProperties(body,()=>frontmatter(source),(range,insert)=>{
   source=range?source.slice(0,range.from)+insert+source.slice(range.to):source;
  },()=>document.querySelector('#welcomeNewButton').focus());
 });
 const initial=await page.evaluate(()=>window.propertySource());
 const field=key=>page.locator(`#propertyRegression input[aria-label="${key}"]`);
 await field('text').fill('CANCEL');await field('text').press('Escape');
 assert.equal(await page.evaluate(()=>window.propertySource()),initial);
 await field('text').fill('COMMIT');await field('text').press('Enter');
 assert.ok((await page.evaluate(()=>window.propertySource())).includes('text: "COMMIT"'));
 await field('number').fill('');await field('number').press('Tab');
 assert.equal(await field('number').inputValue(),'41.25');
 assert.ok((await page.evaluate(()=>window.propertySource())).includes('number: 41.25'));
 await field('items').fill('CANCEL-LIST');await field('items').press('Escape');
 assert.equal(await field('items').inputValue(),'');
 await page.locator('#propertyRegression .leaf-property-enum button').click();
 await page.locator('#propertyRegression .leaf-enum-options input').fill('CANCEL-OPTIONS');
 await page.locator('#propertyRegression .leaf-enum-options input').press('Escape');
 assert.equal(await page.locator('#propertyRegression .leaf-enum-options').count(),0);
 const name=page.locator('#propertyRegression .leaf-property-key').first();
 await name.fill('number');await name.press('Enter');
 assert.equal(await page.locator('#propertyRegression .leaf-property-row').first().locator('.leaf-property-error').isVisible(),true);
 await name.press('Tab');
 assert.equal(await page.locator('#propertyRegression .leaf-property-row').first().locator('.leaf-property-error').innerText(),'');
 await page.locator('#propertyRegression').evaluate(e=>e.remove());
 // Application-level history, keyboard focus, and shared rendering.
 await page.click('#welcomeNewButton');
 const source=()=>page.evaluate(async()=>{
  const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
  return EditorView.findFromDOM(document.querySelector('.cm-content')).state.doc.toString();
 });
 await page.evaluate(async()=>{
  const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
  const view=EditorView.findFromDOM(document.querySelector('.cm-content'));
  const {isolateHistory}=await import('/node_modules/@codemirror/commands/dist/index.js');
  view.dispatch({changes:{from:0,to:view.state.doc.length,insert:'正文\n1. 一\n2. 二\n3. 三'},userEvent:'input'});
  await new Promise(resolve=>setTimeout(resolve,600));
  view.dispatch({changes:{from:3,to:8},userEvent:'delete.selection',annotations:isolateHistory.of('full')});
 });
 assert.equal(await source(),'正文\n1. 二\n2. 三');
 await page.locator('.cm-content').focus();await page.keyboard.press('ControlOrMeta+z');
 assert.equal(await source(),'正文\n1. 一\n2. 二\n3. 三');
 await page.keyboard.press('ControlOrMeta+Shift+z');
 assert.equal(await source(),'正文\n1. 二\n2. 三');
 await page.click('#commandsButton');await page.fill('#paletteInput','callout');
 await page.keyboard.press('Tab');
 assert.equal(await page.evaluate(()=>document.activeElement.id),'paletteInput');
 await page.keyboard.press('Escape');
 await page.locator('.cm-content').focus();await page.keyboard.press('ControlOrMeta+f');
 assert.deepEqual(await page.locator('.leaf-search-main').evaluate(e=>[...e.children].filter(n=>n.name==='toggleReplace'||n.name==='options').map(n=>n.name)),['toggleReplace','options']);
 await page.evaluate(async()=>{
  const {setupStatusNotices}=await import('/src/status-notices.js');
  const {message}=await import('/src/i18n.js');
  const make=()=>document.createElement('span');
  const container=make(),text=make(),recovery=make(),dismiss=make(),announcement=make(),saveIndicator=make();
  const notices=setupStatusNotices({container,text,recovery,dismiss,announcement,saveIndicator});
  notices.show(message('main.waiting_to_autosave'),'pending');
  if(!container.hidden || !saveIndicator.textContent)throw new Error('routine saving occupies banner');
  notices.show(message('main.saved'),'saved');
  if(!container.hidden || !saveIndicator.textContent)throw new Error('saved occupies banner');
  notices.show('real save error','error');
  if(container.hidden || text.textContent!=='real save error')throw new Error('save error concealed');
 });
 assert.deepEqual(errors,[]);
 console.log(`Windows acceptance fixes: ${engine.name()} passed`);
} finally {await browser.close();}
