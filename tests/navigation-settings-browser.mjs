import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import { webkit } from 'playwright';
const useWebKit = process.env.LEAF_TEST_ENGINE === 'webkit';
const browser = await (useWebKit ? webkit.launch({headless:true}) : chromium.launch(launchOptions));
try {
  const page = await browser.newPage({viewport:{width:1100,height:800}}), errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:41732');
  await page.click('#welcomeSettings');
  await page.locator('#appearancePopover').waitFor({state:'visible'});
  await page.click('#settingsTab-recovery');
  assert.ok(await page.locator('#settingsRecovery').isVisible());
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'welcomeSettings');
  await page.click('#welcomeNewButton');
  const source = '第一行\n同一段的第二行\n\n第二段\n\n```js\nconst a = 1;\n\n```\n\n|甲|乙|\n|-|-|\n|一|二|\n\n末段';
  await page.locator('.cm-content').fill(source);
  for (const id of ['imageInsert','attachmentInsert','calloutButton']) assert.ok(await page.locator(`.format-toolbar #${id}`).isVisible());
  assert.equal(await page.locator('#insertMenuButton,#insertPopover,#clipboardMenu').count(),0);
  const getDoc=()=>page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');return EditorView.findFromDOM(document.querySelector('.cm-content')).state.doc.toString();});
  const geometry=()=>page.locator('.cm-line').evaluateAll(es=>es.map(e=>({h:e.getBoundingClientRect().height,y:e.getBoundingClientRect().top})));
  await page.click('#displayButton');
  const before=await geometry();
  await page.check('#blankMarkerToggle');
  assert.equal(await getDoc(),source);
  assert.deepEqual(await geometry(),before,'markers cannot move or resize lines');
  assert.ok(await page.locator('.leaf-editing-marker[data-symbol="¶"]').count()>=3);
  assert.ok(await page.locator('.leaf-editing-marker[data-symbol="↵"]').count()>=3);
  assert.equal(await page.locator('.cm-leaf-code-block .leaf-editing-marker').count(),0,'code fences and contents are inspected in source mode');
  const paint=await page.locator('.leaf-editing-marker').first().evaluate(e=>{const s=getComputedStyle(e,'::after');return {content:s.content,opacity:s.opacity,font:s.fontSize};});
  assert.equal(paint.opacity,'1'); assert.equal(paint.font,'14px'); assert.notEqual(paint.content,'none');
  await page.click('#displayButton');
  await page.click('#documentMenuButton');
  assert.equal(await page.locator('#documentPopover button').count(),1,'the filename menu carries the history entry alone');
  assert.ok(await page.locator('#documentHistory').isVisible());
  await page.keyboard.press('Escape');
  await page.click('#exportMenuButton');
  assert.ok(await page.locator('#exportButton').isVisible());
  await page.keyboard.press('Escape');
  assert.ok(await page.locator('#saveButton').isVisible());
  assert.ok(await page.locator('#displayButton').isVisible());
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#toolsPopover').count(),0);
  assert.ok(await page.getByRole('button',{name:'整理段落空行',exact:true}).isVisible());
  for (const mode of ['source','reading','edit']) {
    await page.click('#readingToggle');await page.click(`[data-mode="${mode}"]`);
    if(mode==='source') { assert.equal(await page.locator('.leaf-editing-marker[data-symbol="¶"]').count(),0);assert.equal(await page.locator('.leaf-editing-marker').count(),source.split('\n').length-1); }
    if(mode==='reading') {assert.equal(await page.locator('#readingPane .leaf-editing-marker').count(),0);await page.click('#displayButton');assert.ok(await page.locator('#markerEditMode').isVisible());await page.click('#displayButton');}
  }
  for(const theme of ['light','dark']) for(const width of [1100,720]) {
    await page.setViewportSize({width,height:width===720?480:800});
    await page.click('#appearanceButton');await page.click('#settingsTab-appearance');await page.selectOption('#themeSelect',theme);await page.click('#settingsClose');
    const bounds=await page.locator('.topbar button,.format-toolbar button').evaluateAll(es=>es.filter(e=>e.getBoundingClientRect().width&&getComputedStyle(e).visibility!=='hidden').map(e=>({id:e.id,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,bottom:e.getBoundingClientRect().bottom})));
    assert.ok(bounds.every(r=>r.left>=0&&r.right<=width),JSON.stringify(bounds.filter(r=>r.left<0||r.right>width)));
    await page.screenshot({path:artifactPath(`${useWebKit ? 'webkit-' : ''}navigation-${theme}-${width}.png`)});
    await page.click('#appearanceButton');await page.click('#settingsTab-recovery');
    assert.equal(await page.locator('#settingsTab-recovery').getAttribute('aria-selected'),'true');
    await page.waitForTimeout(180);
    await page.screenshot({path:artifactPath(`${useWebKit ? 'webkit-' : ''}settings-${theme}-${width}.png`)});
    await page.click('#settingsClose');
  }
  assert.equal(await getDoc(),source);
  assert.deepEqual(errors,[]);
  console.log('PASS navigation ownership, home settings, tabs, document actions, visible markers, source/reading semantics, unchanged bytes/geometry, dark/light 1100/720 layouts');
} finally { await browser.close(); }
