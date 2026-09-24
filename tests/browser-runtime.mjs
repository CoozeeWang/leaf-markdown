import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';

export { chromium };
export const launchOptions = {
  headless: true,
  ...(process.env.LEAF_BROWSER_CHANNEL ? { channel: process.env.LEAF_BROWSER_CHANNEL } : {}),
};
const artifacts = resolve('test-results');
mkdirSync(artifacts, { recursive: true });
export function artifactPath(name) { return resolve(artifacts, basename(name)); }
