// Explicit installed-macOS check: writes only synthetic files in a temporary
// directory. The service may launch Leaf and open the generated test document.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readdir, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';

if (process.platform !== 'darwin') throw new Error('Requires installed macOS Leaf');
const [serviceName, expectedName] = process.argv.slice(2);
if (!serviceName || !['未命名.md', 'Untitled.md'].includes(expectedName)) {
  throw new Error('Provide the system service menu name and expected new filename (Untitled.md or 未命名.md)');
}
const root = await mkdtemp(join(tmpdir(), 'leaf-services-check-'));
const client = join(root, 'client.swift');
await writeFile(client, `import AppKit
let app = NSApplication.shared
let board = NSPasteboard.withUniqueName()
board.writeObjects([NSURL(fileURLWithPath: CommandLine.arguments[1])])
print(NSPerformService(CommandLine.arguments[2], board) ? "accepted" : "rejected")
// Keep the pasteboard alive for a service that dispatches work asynchronously.
RunLoop.current.run(until: Date(timeIntervalSinceNow: 2))
board.releaseGlobally()
`);
const binary = join(root, 'client');
execFileSync('swiftc', ['-module-cache-path', join(root, 'modules'), client, '-o', binary], {stdio: 'pipe'});
for (const selection of ['folder', 'file']) {
  const target = join(root, selection);
  await mkdir(target);
  const selectedFile = join(target, 'existing-sample.md');
  const original = '# Existing sample\n\nKeep this content.\n';
  await writeFile(selectedFile, original);
  const selected = selection === 'folder' ? target : selectedFile;
  const result = execFileSync(binary, [selected, serviceName], {encoding: 'utf8'}).trim();
  assert.equal(result, 'accepted', 'AppKit must accept the service request');
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await readdir(target)).includes(expectedName)) break;
    await wait(100);
  }
  assert.ok((await readdir(target)).includes(expectedName), 'Accepted alone is insufficient: the service must create a document');
  assert.equal(await readFile(selectedFile, 'utf8'), original, 'The selected sample file must remain unchanged');
  const text = await readFile(join(target, expectedName), 'utf8');
  assert.equal(text, '', 'New Markdown starts empty; its default filename is not written into the document');
  console.log(`PASS installed Services IPC: ${selection}, ${expectedName}, existing file unchanged`);
}
console.log('Generated sample documents remain available for native-window inspection. This check does not prove Finder clicking or user acceptance.');
