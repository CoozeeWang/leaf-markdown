import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const script = new URL('../scripts/run-selected-tests.mjs', import.meta.url);
const matched = fileURLToPath(new URL('./fixtures/test-selection/matched.test.js', import.meta.url));
const skipped = fileURLToPath(new URL('./fixtures/test-selection/skip-only.test.js', import.meta.url));
// Before the guard exists, exercise the real unguarded command. This exposes
// Node's zero-match success as an assertion failure, rather than an import error.
function nodeRun(pattern, file = matched) {
  const args = existsSync(script)
    ? [fileURLToPath(script), 'node', '--pattern', pattern, '--files', file]
    : ['--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, file];
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, args, {encoding: 'utf8', env});
}
test('zero matching Node tests fail closed', () => {
  assert.notEqual(nodeRun('no such selected case').status, 0, 'zero executed tests must fail');
});
test('skip-only Node selection fails closed', () => {
  assert.notEqual(nodeRun('selection fixture skipped', skipped).status, 0);
});
test('one matching Node pass reports actual execution counts', () => {
  const result = nodeRun('selection fixture passes');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"executed":1/);
  assert.match(result.stdout, /"passed":1/);
});
test('a failing child preserves nonzero status', () => {
  assert.equal(nodeRun('selection fixture fails').status, 1);
});
test('Node arguments precede files and reject absent files and unknown switches', async () => {
  const {parseSelection} = await import(script);
  const command = parseSelection(['node', '--pattern', 'hello', '--files', matched, skipped]);
  assert.deepEqual(command.args, ['--test', '--test-reporter=tap', '--test-name-pattern=hello', matched, skipped]);
  assert.throws(() => parseSelection(['node', '--pattern', '.', '--files', 'absent.test.js']));
  assert.throws(() => parseSelection(['node', '--pattern', '.', '--files', matched, '--inspect']));
});
test('Node summary parser rejects malformed, missing, duplicate and inconsistent summaries', async () => {
  const {parseNodeSummary} = await import(script);
  const tap = '# tests 3\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 2\n# todo 0\n';
  assert.deepEqual(parseNodeSummary(tap), {selected: 3, executed: 1, passed: 1, failed: 0, skipped: 2});
  for (const bad of ['', tap + '# pass 1\n', tap.replace('# tests 3', '# tests 9'), tap.replace('# pass 1', '# pass huh')]) {
    assert.throws(() => parseNodeSummary(bad));
  }
});
test('Cargo lists identical selector and exactness before execution using invocation fixtures', async () => {
  const {runSelection} = await import(script);
  const calls = [];
  const invoke = (command, args) => {
    calls.push({command, args});
    return {status: 0, stdout: calls.length === 1
      ? 'updates::tests::one: test\n\n1 test, 0 benchmarks\n'
      : 'running 1 test\ntest updates::tests::one ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 4 filtered out; finished in 0.00s\n', stderr: ''};
  };
  const result = runSelection(['cargo', '--manifest-path', 'src-tauri/Cargo.toml', '--filter', 'updates::tests::one', '--exact', '--', '--nocapture'], invoke);
  assert.equal(result.code, 0);
  assert.deepEqual(result.counts, {selected: 1, executed: 1, passed: 1, failed: 0, skipped: 0});
  assert.equal(calls[0].command, 'cargo');
  assert.deepEqual(calls[0].args, [...calls[1].args, '--list']);
  assert.ok(calls[0].args.includes('--exact'));
});
test('Cargo zero-list rejects before execution and zero-run or malformed summary rejects', async () => {
  const {runSelection} = await import(script);
  const argv = ['cargo', '--manifest-path', 'src-tauri/Cargo.toml', '--filter', 'updates'];
  let calls = 0;
  const zero = runSelection(argv, () => { calls++; return {status: 0, stdout: '0 tests, 0 benchmarks\n', stderr: ''}; });
  assert.notEqual(zero.code, 0);
  assert.equal(calls, 1);
  for (const output of ['test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s\n', 'garbage', 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n']) {
    let n = 0;
    const result = runSelection(argv, () => ({status: 0, stdout: ++n === 1 ? 'updates::one: test\nupdates::two: test\n\n2 tests, 0 benchmarks\n' : output, stderr: ''}));
    assert.notEqual(result.code, 0);
  }
});
test('Cargo multiple targets aggregate actual counts and reject ignored-only, list mismatch and unsafe harness flags', async () => {
  const {runSelection, parseSelection} = await import(script);
  const argv = ['cargo', '--manifest-path', 'src-tauri/Cargo.toml', '--filter', 'updates'];
  const list = 'updates::one: test\n\n1 test, 0 benchmarks\n\nupdates::two: test\n\n1 test, 0 benchmarks\n';
  const summary = 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n';
  let n = 0;
  assert.equal(runSelection(argv, () => ({status: 0, stdout: ++n === 1 ? list : summary + summary, stderr: ''})).counts.executed, 2);
  for (const output of ['updates::one: test\n\n9 tests, 0 benchmarks\n', 'updates::one: benchmark\n\n0 tests, 1 benchmark\n']) {
    assert.notEqual(runSelection(argv, () => ({status: 0, stdout: output, stderr: ''})).code, 0);
  }
  n = 0;
  assert.notEqual(runSelection(argv, () => ({status: 0, stdout: ++n === 1 ? list : 'test result: ok. 0 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.00s\n', stderr: ''})).code, 0);
  for (const flag of ['--list', '--skip', '--ignored', '--format=json', 'another-filter']) {
    assert.throws(() => parseSelection([...argv, '--', flag]));
  }
});
