import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const core = [
  'welcome', 'reading', 'sidebars', 'platform-shortcuts', 'table-edges', 'recovery', 'long-document', 'writing', 'attachments', 'writing-structure-regressions',
  'highlight-band', 'selection-compositing', 'selection-edges',
  'footnote-insert', 'footnote-live-preview', 'footnote-panel', 'footnote-auto-delete',
  'footnote-callout', 'footnote-rename', 'footnote-regressions', 'footnotes-print',
  'version-display',
].map(name => `${name}-browser.mjs`);
const available = (await readdir('tests')).filter(name => name.endsWith('-browser.mjs')).sort();
const args = process.argv.slice(2);
const selected = args.includes('--all')
  ? available
  : args.length ? args : core;
for (const name of selected) {
  if (!available.includes(name)) throw new Error(`Unknown browser suite: ${name}`);
}
const server = await createServer({ server: {
  host: '127.0.0.1', port: 41732, strictPort: true,
  watch: { ignored: ['**/src-tauri/target/**', '**/test-results/**', '**/tmp/**', '**/dist/**'] },
} });
let child;
let interrupted = false;
const stop = () => { interrupted = true; child?.kill(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const failed = [];
let completed = 0;
try {
  await server.listen();
  for (const name of selected) {
    if (interrupted) break;
    console.log(`\nRunning ${name}`);
    const passed = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [`tests/${name}`], { stdio: 'inherit', env: process.env });
      const timeout = setTimeout(() => child?.kill(), 180_000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); child = null; resolve(code === 0); });
    });
    if (!passed) failed.push(name);
    completed++;
  }
} finally {
  child?.kill();
  await server.close();
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
if (failed.length) console.error(`Failed suites: ${failed.join(', ')}`);
console.log(`Browser suites: ${completed - failed.length} passed, ${failed.length} failed, ${selected.length - completed} not run${interrupted ? ' (interrupted)' : ''}`);
process.exitCode = failed.length || interrupted ? 1 : 0;
