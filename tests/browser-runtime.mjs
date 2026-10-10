import { chromium as engine } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';

// Existing copy assertions intentionally run in Simplified Chinese. i18n
// suites override locale explicitly to exercise system language resolution.
export const chromium = {
  name: () => engine.name(),
  async launch(options) {
    const browser = await engine.launch(options);
    const page = browser.newPage.bind(browser), context = browser.newContext.bind(browser);
    browser.newPage = options => page({ locale: 'zh-CN', ...options });
    browser.newContext = options => context({ locale: 'zh-CN', ...options });
    return browser;
  },
};
export const launchOptions = {
  headless: true,
  ...(process.env.LEAF_BROWSER_CHANNEL ? { channel: process.env.LEAF_BROWSER_CHANNEL } : {}),
};
const artifacts = resolve('test-results');
mkdirSync(artifacts, { recursive: true });
export function artifactPath(name) { return resolve(artifacts, basename(name)); }
