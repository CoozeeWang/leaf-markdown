import { readdir, readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const target = process.argv[2];
if (!['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc'].includes(target)) throw new Error('Unsupported package target');
const root = join(process.env.CARGO_TARGET_DIR || 'src-tauri/target', target, 'release/bundle');
const output = `test-results/packages/${target}`;
await mkdir(output, { recursive: true });
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
// Only collect finalized installers, never intermediate rw.* disk images or
// stale packages from another version left in the local build directory.
const installerDir = join(root, target.endsWith('darwin') ? 'dmg' : 'nsis');
const files = (await readdir(installerDir, { withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name.startsWith(`Leaf_${version}_`) && /\.(dmg|exe)$/.test(entry.name))
  .map(entry => join(installerDir, entry.name));
if (files.length !== 1) throw new Error(`Expected one finalized installer, found ${files.length}`);
const sums = [];
for (const path of files) {
  const name = `Leaf-${version}-${target}.${path.endsWith('.dmg') ? 'dmg' : 'exe'}`;
  await copyFile(path, join(output, name));
  sums.push(`${createHash('sha256').update(await readFile(path)).digest('hex')}  ${name}`);
}
await writeFile(join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
