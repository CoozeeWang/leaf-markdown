import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium, launchOptions, artifactPath} from './browser-runtime.mjs';

const browser = await chromium.launch(launchOptions);
try {
  await test('AI settings are the third tab and require native confirmed connection state', async () => {
    const page = await browser.newPage({viewport:{width:720,height:720}});
    await page.goto(process.env.LEAF_TEST_BASE_URL || 'http://127.0.0.1:41732/');
    await page.locator('#welcomeSettings').click();
    assert.deepEqual(await page.locator('[data-settings-tab]').allTextContents(), ['外观与排版','保存与恢复','AI 辅助编辑']);
    await page.locator('#settingsTab-ai').click();
    assert.equal(await page.locator('#settingsPanel-ai h3').innerText(), 'MCP 连接');
    assert.equal(await page.locator('#mcpEnabled').isChecked(), false);
    assert.equal(await page.locator('#mcpEnabled').isDisabled(), true);
    assert.match(await page.locator('#aiConnectionError').innerText(), /桌面/);
    assert.deepEqual(await page.locator('#aiClient option').evaluateAll(nodes => nodes.map(n=>n.value)), ['chatgpt','claude-desktop','workbuddy']);
    assert.equal(await page.locator('[data-software-hint]').count(), 0);
    await page.close();
  });
} finally { await browser.close(); }
