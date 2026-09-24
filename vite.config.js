import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// The version line in 设置 is filled from these two build-time constants, so a
// packaged build can be identified from inside the app instead of by hashing
// the binary. The version is read from package.json, which is the same field
// Tauri reads through tauri.conf.json, so the two cannot drift apart here.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// "2b4ee6e · 09-23 18:20", with a trailing + on the commit when the working
// tree had uncommitted changes at build time. A build without git (a source
// tarball on the packaging machine) degrades to the build time alone.
function buildStamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  const time = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const commit = git('rev-parse', '--short=8', 'HEAD');
  if (!commit) return time;
  return `${commit}${git('status', '--porcelain') ? '+' : ''} · ${time}`;
}

export default defineConfig({
  define: {
    __LEAF_VERSION__: JSON.stringify(pkg.version),
    __LEAF_BUILD__: JSON.stringify(buildStamp()),
  },
});
