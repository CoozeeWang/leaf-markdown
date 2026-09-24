// Exercise the shipped WebView2 runtime, including the IPC that creates windows.
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
if (process.platform !== 'win32') throw new Error('Requires Windows and WebView2');
const scratch = await mkdtemp(join(tmpdir(), 'leaf-window-smoke-'));
const fixture = join(scratch, 'existing.md');
await writeFile(fixture, '# Windows native smoke\n\nExisting document body.\n');
await mkdir('test-results', { recursive: true });
const server = net.createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise(r => server.close(r));
const child = spawn(resolve('src-tauri/target/release/leaf.exe'), [], {
  env: { ...process.env, LEAF_NATIVE_SMOKE_PORT: String(port), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: join(scratch, 'webview') },
  stdio: 'inherit',
});
let browser;
let lastConnectionError;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await delay(200);
  }
  throw new Error(`Timed out: ${label}`);
}
async function invoke(page, command, args) {
  return Promise.race([
    page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args }),
    new Promise((_, reject) => { const t = setTimeout(() => reject(new Error(`IPC stalled: ${command}`)), 30000); t.unref(); }),
  ]);
}
// WM_CLOSE is the native message sent by the title-bar X. Do not bypass
// Leaf's close-request/unsaved-document handling with destroy or taskkill.
async function closeNative(page) {
  const title = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|title', {
    label: window.__TAURI_INTERNALS__.metadata.currentWindow.label,
  }));
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LeafCloseProbe {
  public delegate bool Callback(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
  public static bool Close(uint targetPid, string title) {
    bool found = false;
    EnumWindows((hwnd, data) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      var text = new StringBuilder(1024); GetWindowText(hwnd, text, 1024);
      if (pid == targetPid && text.ToString() == title) {
        found = PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
if (-not [LeafCloseProbe]::Close([uint32]$env:LEAF_PROBE_PID, $env:LEAF_PROBE_TITLE)) { throw 'Native window not found' }
`], { env: { ...process.env, LEAF_PROBE_PID: String(child.pid), LEAF_PROBE_TITLE: title }, timeout: 15000 });
}

const pages = () => browser.contexts().flatMap(c => c.pages());
async function nextDocument(before) {
  const page = await until(async () => pages().find(p => !before.includes(p) && p.url().includes('document=1')), 'document window');
  await page.locator('.cm-content').waitFor({ state: 'visible', timeout: 30000 });
  return page;
}
try {
  browser = await until(async () => {
    if (child.exitCode !== null) throw new Error(`Leaf exited: ${child.exitCode}`);
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); } catch (error) { lastConnectionError = error.message; return null; }
  }, 'WebView2 debugging endpoint');
  const launcher = await until(async () => pages().find(p => p.url().includes('tauri.localhost')), 'launcher');
  await launcher.locator('#welcomeNewButton').waitFor();
  let before = pages();
  const newPath = join(scratch, 'new.md');
  await invoke(launcher, 'new_document', { path: newPath });
  await invoke(launcher, 'open_document', { path: newPath });
  const fresh = await nextDocument(before);
  await fresh.locator('.cm-content').fill('New document is editable.');
  assert.match(await fresh.locator('.cm-content').innerText(), /New document is editable/);
  before = pages();
  await invoke(fresh, 'open_document', { path: fixture });
  const existing = await nextDocument(before);
  assert.match(await existing.locator('.cm-content').innerText(), /Existing document body/);
  await existing.screenshot({ path: 'test-results/windows-existing-document.png' });
  const linked = join(scratch, 'linked.md');
  await writeFile(linked, '# Linked document\n');
  before = pages();
  await invoke(existing, 'open_link', { target: 'linked.md' });
  assert.match(await (await nextDocument(before)).locator('.cm-content').innerText(), /Linked document/);
  await invoke(existing, 'open_export', { snapshot: { source: '# Windows export smoke', name: 'Smoke', numbered: false } });
  const preview = await until(async () => pages().find(p => p.url().includes('export=1')), 'export window');
  await preview.locator('.print-document').waitFor();
  assert.match(await preview.locator('.print-document').innerText(), /Windows export smoke/);
  await preview.screenshot({ path: 'test-results/windows-export.png' });
  // Unsaved content must prompt, cancellation must keep the window usable.
  before = pages();
  await invoke(existing, 'open_document', { path: null });
  const dirty = await nextDocument(before);
  await dirty.locator('.cm-content').fill('Unsaved close protection.');
  await closeNative(dirty);
  await dirty.locator('[data-choice="cancel"]').click();
  assert.match(await dirty.locator('.cm-content').innerText(), /Unsaved close protection/);
  await closeNative(dirty);
  await dirty.locator('[data-choice="discard"]').click();
  await until(async () => dirty.isClosed(), 'discard and close');
  assert.equal(child.exitCode, null, 'closing one of several documents must keep Leaf running');
  assert.equal(existing.isClosed(), false);
  const documents = pages().filter(p => p.url().includes('document=1'));
  for (const page of documents) {
    await closeNative(page);
    // A just-edited saved document may still be waiting for autosave.
    await until(async () => {
      if (page.isClosed()) return true;
      const save = page.locator('[data-choice="save"]');
      if (await save.isVisible().catch(() => false)) await save.click();
      return page.isClosed();
    }, 'native document close');
  }
  // The last document must close the hidden launcher and the still-open PDF
  // preview automatically. Never close the launcher explicitly in this test.
  await until(async () => child.exitCode !== null, 'normal process exit');
  assert.equal(child.exitCode, 0);
  assert.equal(launcher.isClosed(), true);
  assert.equal(preview.isClosed(), true);
  console.log('PASS: native Windows new, open, linked document, export, unsaved close/cancel/discard and exit directly after the last document closes.');
} catch (error) {
  console.error('Last CDP connection error:', lastConnectionError);
  try { console.error(execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'leaf|msedgewebview2' } | Select-Object ProcessId,Name,CommandLine | Format-List | Out-String"], { timeout: 10000, encoding: 'utf8' })); } catch {}
  for (const [i, page] of (browser ? pages() : []).entries()) {
    await page.screenshot({ path: `test-results/windows-failure-${i}.png`, timeout: 5000 }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close().catch(() => {});
  if (child.pid && child.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch {} }
}
