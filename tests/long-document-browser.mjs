import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import { longDocument } from './fixtures/long-document.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser = await chromium.launch(launchOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/long-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/src/style.css"></head><body><div id="editor" style="height:750px"></div></body></html>' }));
  await page.goto('http://127.0.0.1:41732/long-fixture');
  const timings = await page.evaluate(async source => {
    const { createLeafEditor } = await import('/src/editor.js');
    const started = performance.now();
    window.ed = createLeafEditor({ parent: document.querySelector('#editor'), doc: source });
    window.original = source;
    return { loadMs: performance.now() - started, characters: source.length, lines: ed.view.state.doc.lines };
  }, longDocument);
  assert.equal(await page.evaluate(() => ed.getValue()), longDocument, 'opening must preserve source');
  // Real keyboard events at a visible caret, surrounded by a large document.
  await page.evaluate(() => {
    const from = ed.getValue().indexOf('SEARCH_TOKEN');
    ed.view.dispatch({ selection: { anchor: from }, scrollIntoView: true }); ed.focus();
  });
  const typed = 'continuous input '.repeat(5);
  const start = performance.now();
  await page.keyboard.type(typed);
  timings.typingMs = performance.now() - start;
  assert.equal(await page.evaluate(() => ed.getValue()), longDocument.replace('SEARCH_TOKEN', typed + 'SEARCH_TOKEN'));
  // Replace via the real search command, then ensure the whole edit is undoable.
  await page.evaluate(async () => {
    const { SearchQuery, setSearchQuery, replaceAll, openSearchPanel } = await import('/node_modules/@codemirror/search/dist/index.js');
    openSearchPanel(ed.view);
    ed.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'SEARCH_TOKEN', replace: 'REPLACED_TOKEN' })) });
    replaceAll(ed.view);
  });
  assert.ok((await page.evaluate(() => ed.getValue())).includes('REPLACED_TOKEN'));
  await page.evaluate(() => { for (let i = 0; i < 100 && ed.getValue() !== original; i++) if (!ed.undo()) break; });
  assert.equal(await page.evaluate(() => ed.getValue()), longDocument, 'undo must recover every original byte');
  timings.renderMs = await page.evaluate(async () => {
    const { renderPrintDocument } = await import('/src/print-document.js');
    const out = document.createElement('article'); out.id = 'print-test'; document.body.append(out);
    const start = performance.now(); renderPrintDocument(out, ed.getValue());
    return performance.now() - start;
  });
  assert.equal(await page.locator('#print-test h2').filter({ hasText: /^章节 / }).count(), 180);
  assert.equal(await page.locator('#print-test table tbody tr').count(), 600);
  assert.equal(await page.evaluate(() => ed.getValue()), longDocument, 'rendering must not edit source');
  // The native WKWebView test consumes the same rendered DOM and export styles,
  // without opening or changing a user's application windows.
  const css = await readFile('src/pdf-export.css', 'utf8') + await readFile('src/callout.css', 'utf8');
  const html = await page.locator('#print-test').innerHTML();
  await writeFile(artifactPath('long-document-native-print.html'), `<!doctype html><html><head><meta charset="utf-8"><style>${css}\n@page { margin: 0; }</style></head><body><article class="print-document">${html}</article></body></html>`);
  // Scroll both extremes, then type again to catch stale caret/viewport state.
  await page.evaluate(() => { ed.view.scrollDOM.scrollTop = 0; });
  await page.evaluate(() => {
    ed.view.dispatch({ selection: { anchor: ed.view.state.doc.length }, scrollIntoView: true }); ed.focus();
  });
  await page.keyboard.type('END_MARKER');
  assert.equal(await page.evaluate(() => ed.getValue()), longDocument + 'END_MARKER');
  await page.screenshot({ path: artifactPath('leaf-long-document.png') });
  await writeFile(artifactPath('long-document-metrics.json'), JSON.stringify(timings, null, 2) + '\n');
  assert.deepEqual(errors, []);
  console.log('PASS long mixed document, continuous input, search/replace, exact undo, shared print rendering and caret after scrolling', timings);
} finally { await browser.close(); }
