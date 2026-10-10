import { chromium, launchOptions } from './browser-runtime.mjs';
import { webkit } from 'playwright';
import assert from 'node:assert/strict';

const browser = process.env.LEAF_TEST_ENGINE === 'webkit'
  ? await webkit.launch({ headless: true }) : await chromium.launch(launchOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:41732');
  await page.click('#welcomeNewButton');
  await page.locator('.cm-content').fill('---\ntitle: Example\ncategory: sample\n---\n\n# Selected heading\n\nSelected body paragraph.\n');
  await page.keyboard.press('Meta+A');
  await page.evaluate(async () => {
    const { EditorView } = await import('/node_modules/@codemirror/view/dist/index.js');
    window.foldSelectionView = EditorView.findFromDOM(document.querySelector('.cm-content'));
  });
  const alignment = () => page.evaluate(() => {
    const view = window.foldSelectionView;
    const first = document.querySelector('.leaf-selectionLayer .cm-selectionBackground');
    const selected = view.state.selection.main;
    return {
      selectedFrom: selected.from,
      markerTop: first?.getBoundingClientRect().top,
      textTop: view.coordsAtPos(selected.from, 1)?.top,
    };
  });
  const expectAligned = async label => {
    await page.waitForTimeout(100);
    const geometry = await alignment();
    assert.ok(geometry.markerTop !== undefined && geometry.textTop !== undefined, `${label}: selection geometry exists`);
    assert.ok(Math.abs(geometry.markerTop - geometry.textTop) < 12, `${label}: highlight follows text ${JSON.stringify(geometry)}`);
  };
  assert.ok(await page.evaluate(() => {
    const view = window.foldSelectionView;
    return view.state.selection.main.from >= view.state.doc.toString().indexOf('# Selected heading') - 1;
  }), 'Cmd+A begins at body');
  await expectAligned('initial');
  for (const label of ['collapsed', 'expanded', 'collapsed again', 'expanded again']) {
    await page.locator('.leaf-yaml .leaf-block-top button').first().click();
    await expectAligned(label);
  }
  await page.click('#displayButton');
  await page.locator('#documentPropertiesToggle').uncheck();
  await expectAligned('collapsed from display menu');
  await page.locator('#documentPropertiesToggle').check();
  await expectAligned('expanded from display menu');
  assert.deepEqual(errors, []);
  console.log('PASS selected body highlight follows document property fold in both directions');
} finally {
  await browser.close();
}
