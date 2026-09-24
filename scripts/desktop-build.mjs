import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// macOS does not provide C.UTF-8; create-dmg's system Perl aborts under it.
// Limit this environment adjustment to the build process, not the application.
const env = { ...process.env };
if (process.platform === 'darwin') {
  env.LANG = env.LC_ALL = env.LC_CTYPE = 'en_US.UTF-8';
}
const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
const child = spawn(process.execPath, [cli, 'build', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
