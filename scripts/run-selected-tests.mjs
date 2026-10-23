import {spawnSync} from 'node:child_process';
import {statSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const requireValue = (value) => {
  if (!value || value.startsWith('-') || value.includes('\0')) throw new Error('invalid argument value');
  return value;
};
const requireFile = (file) => {
  requireValue(file);
  if (!statSync(file).isFile()) throw new Error('input is not a file');
  return file;
};

export function parseSelection(argv) {
  const [mode, ...input] = argv;
  if (mode === 'node') {
    if (input[0] !== '--pattern' || input[2] !== '--files' || input.length < 4) throw new Error('expected node --pattern PATTERN --files FILE...');
    const pattern = requireValue(input[1]);
    new RegExp(pattern);
    const files = input.slice(3).map(requireFile);
    return {mode, command: process.execPath, args: ['--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, ...files]};
  }
  if (mode !== 'cargo') throw new Error('expected node or cargo');
  if (input[0] !== '--manifest-path' || input[2] !== '--filter') throw new Error('expected cargo --manifest-path FILE --filter FILTER');
  const manifest = requireFile(input[1]);
  const filter = requireValue(input[3]);
  let rest = input.slice(4);
  const exact = rest[0] === '--exact';
  if (exact) rest = rest.slice(1);
  if (rest.length && rest.shift() !== '--') throw new Error('invalid Cargo arguments');
  // Keep reporting, selection and ignore semantics fixed in both invocations.
  for (const flag of rest) {
    if (!['--nocapture', '--no-capture', '--show-output'].includes(flag) && !/^--test-threads=[1-9]\d*$/.test(flag)) throw new Error('unsupported harness argument');
  }
  const args = ['test', '--locked', '--manifest-path', manifest, filter, '--', ...(exact ? ['--exact'] : []), ...rest];
  return {mode, command: 'cargo', args, filter, exact};
}

export function parseNodeSummary(output, files = []) {
  const values = {};
  for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
    if (matches.length !== 1) throw new Error('missing or malformed Node summary');
    values[key] = Number(matches[0][1]);
    if (!Number.isSafeInteger(values[key])) throw new Error('invalid Node count');
  }
  if (values.tests !== values.pass + values.fail + values.cancelled + values.skipped + values.todo) throw new Error('inconsistent Node summary');
  if (values.cancelled || values.todo) throw new Error('incomplete Node execution');
  // Node 24 reports an empty filtered file as a passing file-wrapper test.
  // Such a wrapper is not an executed case (Node 22 may instead report skips).
  const wrappers = [...output.matchAll(/^1\.\.0\r?\n# Subtest: (.+)\r?\nok \d+ - \1\r?$/gm)];
  for (const wrapper of wrappers) {
    if (!files.some((file) => resolve(file) === resolve(wrapper[1]))) throw new Error('unknown empty test wrapper');
    values.tests--; values.pass--;
  }
  if (values.tests < 0 || values.pass < 0) throw new Error('invalid empty test wrappers');
  return {selected: values.tests, executed: values.pass + values.fail, passed: values.pass, failed: values.fail, skipped: values.skipped};
}

function parseCargoList(output, filter, exact) {
  let entries = 0, declared = 0, summaries = 0;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = line.match(/^(.+): (test|benchmark)$/);
    const summary = line.match(/^(\d+) tests?, (\d+) benchmarks?$/);
    if (entry) {
      if (entry[2] !== 'test' || !(exact ? entry[1] === filter : entry[1].includes(filter))) throw new Error('unexpected Cargo list entry');
      entries++;
    } else if (summary) {
      if (Number(summary[2]) !== 0) throw new Error('benchmarks are not selected tests');
      declared += Number(summary[1]); summaries++;
    } else throw new Error('malformed Cargo list');
  }
  if (!summaries || !entries || entries !== declared || !Number.isSafeInteger(declared)) throw new Error('empty or inconsistent Cargo list');
  return entries;
}

function parseCargoSummary(output, selected) {
  const summaries = [...output.matchAll(/^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in [^\r\n]+\r?$/gm)];
  if (!summaries.length || (output.match(/^test result:/gm) || []).length !== summaries.length) throw new Error('missing or malformed Cargo summary');
  const counts = {selected, executed: 0, passed: 0, failed: 0, skipped: 0};
  for (const match of summaries) {
    const [passed, failed, skipped, measured] = match.slice(2, 6).map(Number);
    if (measured || (match[1] === 'ok' && failed) || (match[1] === 'FAILED' && !failed)) throw new Error('inconsistent Cargo result');
    counts.passed += passed; counts.failed += failed; counts.skipped += skipped;
  }
  counts.executed = counts.passed + counts.failed;
  if (!Object.values(counts).every(Number.isSafeInteger) || selected !== counts.executed + counts.skipped) throw new Error('Cargo execution differs from matching list');
  return counts;
}

function invoke(command, args) {
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(command, args, {encoding: 'utf8', shell: false, env, maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60 * 1000});
}

export function runSelection(argv, run = invoke) {
  let child;
  try {
    const spec = parseSelection(argv);
    let selected;
    if (spec.mode === 'cargo') {
      child = run(spec.command, [...spec.args, '--list']);
      if (child.error || child.status !== 0) return {code: child.status || 1, error: 'Cargo listing failed'};
      selected = parseCargoList(child.stdout, spec.filter, spec.exact);
    }
    child = run(spec.command, spec.args);
    if (child.error || child.status === null) return {code: 1, error: 'test process failed'};
    const counts = spec.mode === 'node' ? parseNodeSummary(child.stdout, spec.args.slice(3)) : parseCargoSummary(child.stdout, selected);
    const code = child.status || (!counts.selected || !counts.executed || counts.failed ? 1 : 0);
    return {code, counts};
  } catch (error) {
    return {code: child?.status || 1, error: error.message};
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = runSelection(process.argv.slice(2), (command, args) => {
    const child = invoke(command, args);
    // Preserve the real assertion/compiler diagnostic without changing counts.
    // Callers still receive the single machine-readable result on stdout.
    if (child.status !== 0) {
      if (child.stdout) process.stderr.write(child.stdout);
      if (child.stderr) process.stderr.write(child.stderr);
    }
    return child;
  });
  console.log(JSON.stringify(result));
  process.exitCode = result.code;
}
