// Public synthetic transport regression. The host streams deliberately have no fd.
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {PassThrough} = require('node:stream');
const {EventEmitter, once} = require('node:events');
const vm = require('node:vm');
const {spawn} = require('node:child_process');

async function run(source, config, input, signal) {
  const host = new EventEmitter();
  host.stdin = new PassThrough();
  host.stdout = new PassThrough();
  host.stderr = new PassThrough();
  host.env = {...process.env, SYNTHETIC_HOST_FLAG: 'host'};
  let stdout = '', stderr = '', child;
  host.stdout.setEncoding('utf8').on('data', s => {stdout += s;});
  host.stderr.setEncoding('utf8').on('data', s => {stderr += s;});
  const context = {process: host, console: {error: (...args) => {stderr += args.join(' ') + '\n';}},
    require: name => {
      assert.equal(name, 'node:child_process');
      return {spawn: (...args) => {assert.equal(args[2].windowsHide, true); child = spawn(...args); return child;}};
    }};
  vm.runInNewContext(`const c=${JSON.stringify(config)};\n${source}`, context);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const closed = new Promise(resolve => child.on('close', resolve));
    if (signal) {await once(child, 'spawn'); host.emit(signal);}
    else host.stdin.end(input);
    await closed;
    return {stdout, stderr, code: host.exitCode, childSignal: child.signalCode};
  } finally {clearTimeout(timeout); host.stdin.destroy();}
}

(async () => {
  const source = readFileSync(process.argv[2], 'utf8');
  const text = 'Synthetic 空格 😀\\ literal\n'.repeat(8192);
  const echo = `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{process.stderr.write('synthetic diagnostic\\n');process.stdout.write(JSON.stringify({text:s,host:process.env.SYNTHETIC_HOST_FLAG,child:process.env.SYNTHETIC_CHILD_FLAG}));process.exitCode=7;});`;
  const result = await run(source, {command: process.execPath, args: ['-e', echo], env: {SYNTHETIC_CHILD_FLAG: 'child'}}, text);
  assert.deepEqual(JSON.parse(result.stdout), {text, host: 'host', child: 'child'});
  assert.equal(result.stderr, 'synthetic diagnostic\n');
  assert.equal(result.code, 7);
  const missing = await run(source, {command: process.execPath + '-synthetic-missing', args: []}, '');
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /ENOENT/);
  const stopped = await run(source, {command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)']}, '', 'SIGTERM');
  assert.equal(stopped.childSignal, 'SIGTERM');
  console.log('Virtual host transport passed: Unicode/backpressure, EOF, stdout/stderr, env, exit, spawn failure, signal.');
})().catch(e => {console.error(e);process.exitCode=1;});
