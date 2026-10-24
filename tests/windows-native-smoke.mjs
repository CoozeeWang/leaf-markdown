// Exercise the shipped WebView2 runtime, including the IPC that creates windows.
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rename, readFile, realpath, copyFile } from 'node:fs/promises';
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
const child = spawn(resolve(process.env.LEAF_NATIVE_SMOKE_EXE || 'src-tauri/target/release/leaf.exe'), [], {
  env: { ...process.env, ...(process.argv.includes('--launcher-close-only') ? {APPDATA:join(scratch,'profile'),LEAF_NATIVE_SMOKE_SAFE_BROWSER:'1'} : {}), LEAF_NATIVE_SMOKE_PORT: String(port), LEAF_NATIVE_SMOKE_PDF_DIR: scratch, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: join(scratch, 'webview') },
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
        found = ${process.argv.includes('--system-close') ? 'PostMessage(hwnd, 0x0112, new IntPtr(0xF060), IntPtr.Zero)' : 'PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero)'};
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
if (-not [LeafCloseProbe]::Close([uint32]$env:LEAF_PROBE_PID, $env:LEAF_PROBE_TITLE)) { throw 'Native window not found' }
`], { env: { ...process.env, LEAF_PROBE_PID: String(child.pid), LEAF_PROBE_TITLE: title }, timeout: 60000 });
}

const pages = () => browser.contexts().flatMap(c => c.pages());
async function nextDocument(before) {
  const page = await until(async () => pages().find(p => !before.includes(p) && p.url().includes('document=1')), 'document window');
  await page.locator('.cm-content').waitFor({ state: 'visible', timeout: 30000 });
  // CDP sees the DOM while the WebView is still loading in a hidden window.
  // Interact only after initialization and the real native reveal have finished.
  await page.waitForFunction(()=>document.querySelector('.shell')?.style.pointerEvents!=='none');
  const label=await page.evaluate(()=>window.__TAURI_INTERNALS__.metadata.currentWindow.label);
  await until(()=>invoke(page,'plugin:window|is_visible',{label}),'visible document window');
  return page;
}
try {
  browser = await until(async () => {
    if (child.exitCode !== null) throw new Error(`Leaf exited: ${child.exitCode}`);
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); } catch (error) { lastConnectionError = error.message; return null; }
  }, 'WebView2 debugging endpoint');
  const launcher = await until(async () => pages().find(p => p.url().includes('tauri.localhost')), 'launcher');
  await launcher.locator('#welcomeNewButton').waitFor();
  if (process.argv.includes('--launcher-close-only')) {
    // This runs the real close handler in an isolated native test executable
    // without an installer or legacy browser overrides. SC_CLOSE is the native
    // system-command route used by Alt+F4; physical keyboard acceptance is separate.
    assert.equal(await launcher.evaluate(()=>window.__TAURI_INTERNALS__.metadata.currentWindow.label),'main');
    await launcher.waitForLoadState('load');
    await launcher.waitForFunction(()=>document.querySelector('.shell')?.style.pointerEvents!=='none');
    const language=process.argv.find(arg=>arg.startsWith('--close-language='))?.split('=')[1];
    if(language)await invoke(launcher,'language_set',{preference:language});
    for(const command of ['update_close_disposition','update_close_complete','update_participant_status']) {
      await assert.rejects(invoke(launcher,command),/window_role_denied/);
    }
    if(process.argv.includes('--with-documents')) {
      let before=pages();await invoke(launcher,'open_document',{path:fixture});
      const existing=await nextDocument(before);
      before=pages();await invoke(existing,'open_document',{path:null});
      const dirty=await nextDocument(before);
      await dirty.locator('.cm-content').fill('Synthetic unsaved close protection.');
      await closeNative(launcher);
      await until(()=>launcher.isClosed(),'launcher closed without closing documents');
      assert.equal(existing.isClosed(),false);assert.equal(dirty.isClosed(),false);assert.equal(child.exitCode,null);
      await closeNative(dirty);await dirty.locator('[data-choice="cancel"]').click();
      assert.match(await dirty.locator('.cm-content').innerText(),/Synthetic unsaved close protection/);
      assert.equal(existing.isClosed(),false);
      assert.equal(await readFile(fixture,'utf8'),'# Windows native smoke\n\nExisting document body.\n');
      await closeNative(dirty);await dirty.locator('[data-choice="discard"]').click();
      await until(()=>dirty.isClosed(),'synthetic discarded window closed');
      await closeNative(existing);
    } else await closeNative(launcher);
    await until(()=>child.exitCode!==null,'normal launcher/process exit');
    assert.equal(child.exitCode,0);
    console.log(`PASS: production Windows launcher ${process.argv.includes('--system-close')?'SC_CLOSE':'WM_CLOSE'}, updater permissions denied, ${process.argv.includes('--with-documents')?'other document and unsaved cancellation preserved':'empty welcome exited normally'}.`);
  } else if (process.argv.includes('--pdf-only')) {
    await mkdir('test-results/windows-pdf', { recursive: true });
    for (const [name, source] of [
      ['short', 'One synthetic line.'],
      ['中文標題-é-😀', '# Windows export smoke\n\n中文正文。\n\n' + 'Pagination text.\n\n'.repeat(120) + 'FINAL-CONTENT-END'],
    ]) {
      const before = pages();
      await invoke(launcher, 'open_export', { snapshot: { source, name: `${name}.md`, numbered: false } });
      const preview = await until(async () => pages().find(p => !before.includes(p) && p.url().includes('export=1')), 'PDF export preview');
      await preview.locator('.print-document').waitFor();
      await until(async () => (await preview.title()) === name, 'PDF title ready');
      assert.equal(await invoke(preview, 'plugin:window|is_visible', {
        label: await preview.evaluate(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label),
      }), true, 'Export preview must be natively visible');
      const exported = join(scratch, `${name}.pdf`);
      for (let attempt = 0; attempt < 2; attempt++) {
        await invoke(preview, 'print_export');
        if (name === 'short') {
          execFileSync('python', ['-c', "from pypdf import PdfReader; import sys; p=PdfReader(sys.argv[1]); assert len(p.pages)==1; assert 'One synthetic line.' in p.pages[0].extract_text()", exported], { stdio: 'inherit' });
        } else {
          execFileSync('python', ['tests/pdf-title-check.py', exported, name], { stdio: 'inherit' });
        }
      }
      await copyFile(exported, join('test-results/windows-pdf', `${name}.pdf`));
      await preview.screenshot({ path: `test-results/windows-pdf/${name}.png` });
    }
    console.log('PASS: actual Leaf short, Unicode multipage PDF export and overwrite.');
  } else {
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
  await invoke(existing, 'open_export', { snapshot: { source: '# Windows export smoke\n\n中文正文。\n\n' + 'Pagination text.\n\n'.repeat(120) + 'FINAL-CONTENT-END', name: '中文標題-é-😀.md', numbered: false } });
  const preview = await until(async () => pages().find(p => p.url().includes('export=1')), 'export window');
  await preview.locator('.print-document').waitFor();
  assert.match(await preview.locator('.print-document').innerText(), /Windows export smoke/);
  // CDP can inspect and screenshot a hidden WebView. Check the native window,
  // not only DOM visibility, so an invisible export preview cannot pass.
  assert.equal(await invoke(preview, 'plugin:window|is_visible', {
    label: await preview.evaluate(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label),
  }), true, 'PDF export preview must be visible to the user');
  await preview.screenshot({ path: 'test-results/windows-export.png' });
  assert.equal(await preview.title(), '中文標題-é-😀');
  await invoke(preview, 'print_export');
  const exported = join(scratch, '中文標題-é-😀.pdf');
  execFileSync('python', ['tests/pdf-title-check.py', exported, '中文標題-é-😀'], { stdio: 'inherit' });
  // Save twice: the second render must safely replace the existing PDF.
  await invoke(preview, 'print_export');
  execFileSync('python', ['tests/pdf-title-check.py', exported, '中文標題-é-😀'], { stdio: 'inherit' });

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
  // An open document follows only the same file. A replacement at the old
  // name must not receive later saves.
  const renamed = join(scratch, 'renamed.md');
  await rename(fixture, renamed);
  await until(async () => (await existing.title()).includes('renamed.md'), 'external rename followed');
  const movedDir = join(scratch, 'moved');
  await mkdir(movedDir);
  const moved = join(movedDir, 'moved.md');
  await rename(renamed, moved);
  await writeFile(renamed, 'substitute');
  await until(async () => (await existing.title()).includes('moved.md'), 'external move followed');
  await existing.locator('.cm-content').fill('# Saved at moved path');
  await until(async () => (await readFile(moved, 'utf8')) === '# Saved at moved path', 'save after external move');
  assert.equal(await readFile(renamed, 'utf8'), 'substitute');
  const recent = await invoke(existing, 'recent_list');
  const samePath = (a, b) => a.replace(/^\\\\\?\\/, '').toLowerCase() === b.replace(/^\\\\\?\\/, '').toLowerCase();
  assert.equal(recent[0]?.name, 'moved.md');
  assert(samePath(await realpath(recent[0].path), await realpath(moved)), `recent=${recent[0].path}, moved=${moved}`);
  assert(!recent.some(item => item.name === 'existing.md' || item.name === 'renamed.md'));
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
  console.log('PASS: native Windows new, open, linked document, export, external rename/move with safe save, unsaved close/cancel/discard and exit.');
  }
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
