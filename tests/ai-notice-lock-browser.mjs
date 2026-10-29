import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { nativePage } from './ai-browser-fixture.mjs';

// Both desktop platforms share this renderer. Platform mocks cover routing;
// Chromium/WebKit checks do not replace installed WebView2/WKWebView acceptance.
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch({headless:true});
  try {
    for (const os of ['macos', 'windows']) {
      const page = await nativePage(browser, os);
      await page.keyboard.press('Escape');
      for (let cycle = 0; cycle < 4; cycle++) {
        await page.evaluate(async cycle => {
          const call = async (operation, args) => {
            const call_id = `notice-${cycle}-${operation}`;
            await emitNative('leaf-mcp-editor', {call_id, operation, args});
            const reply = aiMock.calls.findLast(c => c.command === 'mcp_renderer_reply' && c.args.callId === call_id)?.args.reply;
            if (reply?.error) throw Error(JSON.stringify(reply.error));
          };
          await call('snapshot', {});
          const revision = aiMock.calls.findLast(c => c.command === 'mcp_renderer_reply').args.reply.result.revision;
          const binding = {document_id:'doc-ui', session_id:'session-ui', authorization_epoch:4, mutation_generation:0, revision};
          await call('binding', binding);
          await call('begin', {...binding, task_id:`notice-task-${cycle}`, client:'chatgpt', scope:{from:0,to:1}});
        }, cycle);
        const notice = page.locator('#aiTaskNotice');
        await notice.waitFor();
        for (const language of ['zh-Hans', 'zh-Hant-TW', 'en']) {
          await page.evaluate(async language => {
            const {setLanguagePreference} = await import('/src/i18n.js');
            await setLanguagePreference(language);
          }, language);
          assert.equal(await notice.locator('svg').count(), 1, `${engine.name()}/${os}: cycle ${cycle} has exactly one icon`);
          assert.equal(await notice.locator('.ai-task-lock').count(), 1);
          assert.equal(await notice.locator('.ai-task-copy').count(), 1);
          assert.equal(await notice.locator('.ai-task-copy svg').count(), 0);
          assert.match(await notice.locator('.ai-task-copy').innerText(), /ChatGPT/);
          for (const width of [390, 1000]) {
            await page.setViewportSize({width,height:720});
            const bounds = await notice.evaluate(node => {
              const lock = node.querySelector('.ai-task-lock').getBoundingClientRect();
              const copy = node.querySelector('.ai-task-copy').getBoundingClientRect();
              const button = node.querySelector('button').getBoundingClientRect();
              return {lockRight:lock.right, copyLeft:copy.left, copyRight:copy.right, buttonLeft:button.left, buttonRight:button.right};
            });
            assert.ok(bounds.lockRight <= bounds.copyLeft && bounds.copyRight <= bounds.buttonLeft);
            assert.ok(bounds.buttonRight <= width);
          }
        }
        await page.evaluate(async cycle => {
          await emitNative('leaf-mcp-editor', {call_id:`notice-end-${cycle}`, operation:'finish', args:{task_id:`notice-task-${cycle}`, session_id:'session-ui', document_id:'doc-ui', authorization_epoch:4, mutation_generation:0}});
        }, cycle);
        assert.equal(await notice.isHidden(), true);
        assert.equal(await page.locator('.cm-content').first().getAttribute('aria-readonly'), 'false');
      }
      await page.close();
      console.log(`${engine.name()}/${os}: consecutive task notices passed`);
    }
  } finally { await browser.close(); }
}
