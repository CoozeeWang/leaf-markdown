import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';

// Extra configuration could replace the isolated identifier or data store.
// Keep this managed entry point fixed; backend changes restart automatically.
if (process.argv.length > 2) {
  console.error('Leaf Dev does not accept extra arguments. Run npm run desktop:dev.');
  process.exit(1);
}
// Named WKWebView stores are available since macOS 14. Refuse to silently
// fall back to the installed app's default store on an older system.
if (process.platform === 'darwin' && Number(execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).split('.')[0]) < 14) {
  console.error('Leaf Dev requires macOS 14 or later for isolated persistent settings.');
  process.exit(1);
}
if (process.platform === 'darwin' && typeof process.execve !== 'function') {
  console.error('Leaf Dev requires Node.js 22.15 or later for reliable native restarts.');
  process.exit(1);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
const config = fileURLToPath(new URL('../src-tauri/tauri.dev.conf.json', import.meta.url));
const env = { ...process.env, LEAF_DESKTOP_DEV: '1' };
// Respect the operator's toolchain, including the standard per-user Cargo bin.
const cargoBin = join(process.env.CARGO_HOME || join(homedir(), '.cargo'), 'bin');
env.PATH = `${dirname(process.execPath)}${delimiter}${cargoBin}${delimiter}${env.PATH || ''}`;
if (process.platform === 'darwin') {
  // Cargo executes runners from src-tauri; relative paths avoid quoting an
  // arbitrary checkout path with spaces in an environment string.
  env.CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER = 'node ../scripts/desktop-dev-macos.mjs';
  env.CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER = 'node ../scripts/desktop-dev-macos.mjs';
}
const child = spawn(process.execPath, [cli, 'dev', '--config', config], { cwd: root, stdio: 'inherit', env });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
