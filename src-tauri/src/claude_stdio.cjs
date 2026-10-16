// Claude Desktop can expose MCP through JavaScript streams rather than OS fds.
// Pipe explicitly: inherited descriptors bypass the host's transport.
const {spawn} = require('node:child_process');
const child = spawn(c.command, c.args, {
  env: {...process.env, ...c.env},
  stdio: 'pipe',
  windowsHide: true,
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on('error', error => {
  if (error.code !== 'EPIPE') console.error('MCP input forwarding failed:', error.code);
});
child.on('error', error => {
  console.error('Could not start the local MCP adapter:', error.code);
  process.exitCode = 1;
});
// close follows stdout/stderr draining; exit can truncate the last MCP response.
child.on('close', code => {
  process.stdin.unpipe(child.stdin);
  process.stdin.pause();
  process.exitCode = Number.isInteger(code) && code >= 0 ? code : 1;
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => child.kill(signal));
}
