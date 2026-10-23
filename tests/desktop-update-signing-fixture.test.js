import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, symlinkSync, statSync, utimesSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, generateKeyPairSync, sign, verify, createPublicKey} from 'node:crypto';

const script = new URL('../scripts/desktop-update-signing-fixture.mjs', import.meta.url);
const identity = {version: '9.8.7-beta.1', platform: 'darwin', arch: 'aarch64'};
function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'leaf-update-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}
async function fixture(t) {
  const api = await import(script);
  const root = temporary(t);
  const evidenceRoot = join(root, 'evidence');
  const init = api.fixtureInit({runRoot: root, evidenceRoot, ...identity});
  const payloadFile = join(root, 'synthetic-package.bin');
  writeFileSync(payloadFile, 'Leaf fictional freshly built package\n');
  return {api, root, evidenceRoot, init, payloadFile, options: {runRoot: root, evidenceRoot, payloadFile, ...identity}};
}
test('version metadata is authenticated with exact signed bytes', async (t) => {
  if (!existsSync(script)) {
    // Real content-only Ed25519 is insufficient: changing the version leaves
    // its verification true. This assertion is RED without a missing import.
    const pair = generateKeyPairSync('ed25519');
    const payload = Buffer.from('fictional package');
    const signature = sign(null, payload, pair.privateKey);
    const artifact = {payload, signature, version: identity.version};
    const contentOnlyVerify = (candidate) => verify(null, candidate.payload, pair.publicKey, candidate.signature);
    assert.equal(contentOnlyVerify(artifact), true);
    assert.equal(contentOnlyVerify({...artifact, version: '9.8.8'}), false, 'changed version must fail verification');
    return;
  }
  const f = await fixture(t);
  f.api.signFixture(f.options);
  assert.throws(() => f.api.verifyFixture({...f.options, version: '9.8.8'}));
});
test('fresh fixture creation remains ordered on the CI filesystem', async (t) => {
  let minimumBirthDelta = Infinity;
  let minimumModificationDelta = Infinity;
  for (let i = 0; i < 100; i++) {
    const f = await fixture(t);
    const createdMs = JSON.parse(readFileSync(join(f.root, 'run-manifest.json'))).createdMs;
    const payload = statSync(f.payloadFile);
    minimumBirthDelta = Math.min(minimumBirthDelta, payload.birthtimeMs - createdMs);
    minimumModificationDelta = Math.min(minimumModificationDelta, payload.mtimeMs - createdMs);
    f.api.signFixture(f.options);
  }
  t.diagnostic(`minimum fresh payload deltas: birth ${minimumBirthDelta.toFixed(3)} ms, modification ${minimumModificationDelta.toFixed(3)} ms`);
});
test('fresh TEST-ONLY signer signs once and authenticates bytes, platform, arch and run', async (t) => {
  const f = await fixture(t);
  assert.equal(f.init.mode, 'TEST-ONLY-THROWAWAY');
  assert.match(f.init.fingerprint, /^[a-f0-9]{64}$/);
  const signed = f.api.signFixture(f.options);
  assert.equal(signed.status, 'signed');
  assert.equal(f.api.verifyFixture(f.options).status, 'verified');
  for (const change of [{platform: 'windows'}, {arch: 'x86_64'}, {version: '9.8.6'}]) assert.throws(() => f.api.verifyFixture({...f.options, ...change}));
  assert.throws(() => f.api.signFixture(f.options));
  assert.throws(() => f.api.fixtureInit({runRoot: f.root, evidenceRoot: f.evidenceRoot, ...identity}));
  writeFileSync(f.payloadFile, 'changed bytes');
  assert.throws(() => f.api.verifyFixture(f.options));
});
test('minisign artifact binds prehashed bytes and trusted version with independent Node primitives', async (t) => {
  const f = await fixture(t);
  f.api.signFixture(f.options);
  const signature = Buffer.from(readFileSync(join(f.evidenceRoot, 'payload.sig'), 'utf8').trim(), 'base64').toString('utf8').trim().split('\n');
  const publicText = Buffer.from(readFileSync(join(f.root, 'signer-public.key'), 'utf8').trim(), 'base64').toString('utf8');
  const rawKey = Buffer.from(publicText.trim().split('\n')[1], 'base64');
  const block = Buffer.from(signature[1], 'base64');
  assert.equal(block.subarray(0, 2).toString(), 'ED');
  assert.equal(rawKey.subarray(0, 2).toString(), 'Ed');
  assert.deepEqual(block.subarray(2, 10), rawKey.subarray(2, 10));
  const key = createPublicKey({format: 'der', type: 'spki', key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey.subarray(10)])});
  assert.ok(verify(null, createHash('blake2b512').update(readFileSync(f.payloadFile)).digest(), key, block.subarray(10)));
  const comment = signature[2].replace(/^trusted comment: /, '');
  assert.match(comment, /version:9\.8\.7-beta\.1/);
  assert.ok(verify(null, Buffer.concat([block.subarray(10), Buffer.from(comment)]), key, Buffer.from(signature[3], 'base64')));
});
test('fixture rejects cached bytes, outside paths, symlinks, non-disposable roots and changed manifest', async (t) => {
  const f = await fixture(t);
  const old = new Date(Date.now() - 60000);
  utimesSync(f.payloadFile, old, old);
  assert.throws(() => f.api.signFixture(f.options));
  const outside = join(temporary(t), 'outside.bin'); writeFileSync(outside, 'fictional');
  assert.throws(() => f.api.signFixture({...f.options, payloadFile: outside}));
  const link = join(f.root, 'link.bin'); symlinkSync(outside, link);
  assert.throws(() => f.api.signFixture({...f.options, payloadFile: link}));
  assert.throws(() => f.api.fixtureInit({runRoot: process.cwd(), evidenceRoot: join(f.root, 'other'), ...identity}));
  const fresh = join(f.root, 'fresh.bin'); writeFileSync(fresh, 'fresh');
  f.api.signFixture({...f.options, payloadFile: fresh});
  const manifestFile = join(f.root, 'run-manifest.json');
  chmodSync(manifestFile, 0o600);
  const manifest = JSON.parse(readFileSync(manifestFile)); manifest.version = '1.0.0';
  writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(() => f.api.verifyFixture({...f.options, payloadFile: fresh}));
});
test('evidence contains no private bytes or local paths', async (t) => {
  const f = await fixture(t);
  f.api.signFixture(f.options);
  const evidence = readFileSync(join(f.evidenceRoot, 'fixture-evidence.json'), 'utf8');
  assert.doesNotMatch(evidence, /PRIVATE KEY|privateKey|BEGIN|\/Users\/|\/home\//);
  assert.ok(!evidence.includes(f.root));
});
test('POSIX fixture signer permissions are owner-only', {skip: process.platform === 'win32' ? 'Windows uses ACLs rather than POSIX modes' : false}, async (t) => {
  const f = await fixture(t);
  assert.equal(statSync(join(f.root, 'signer-private.pem')).mode & 0o777, 0o600);
});
test('missing production public identity stays pending with owner and reentry while fixture works', async (t) => {
  const f = await fixture(t);
  const result = f.api.productionReadiness({evidenceRoot: f.evidenceRoot});
  assert.equal(result.status, 'pending_external_identity');
  assert.equal(result.owner, 'Leaf release custodian');
  assert.match(result.reentry, /production-readiness --public-key-file/);
  assert.equal(result.productionEnabled, false);
  f.api.signFixture(f.options);
  assert.equal(f.api.verifyFixture(f.options).status, 'verified');
});
function publicIdentity(root, extra = {}) {
  // Fictional public bytes only: production tests never generate private keys.
  const key = Buffer.concat([Buffer.from('Ed'), Buffer.alloc(8, 4), Buffer.alloc(32, 7)]);
  const publicKeyFile = join(root, 'leaf-public.key');
  writeFileSync(publicKeyFile, Buffer.from(`untrusted comment: Leaf updater public key\n${key.toString('base64')}\n`).toString('base64'), {mode: 0o600});
  const fingerprint = createHash('sha256').update(key.subarray(10)).digest('hex');
  const provenanceFile = join(root, 'provenance.json');
  writeFileSync(provenanceFile, JSON.stringify({schema: 1, product: 'Leaf', purpose: 'updater-signing', mode: 'production', owner: 'Leaf release custodian', source: 'secure-local-custodian', fingerprint, independent: true, ...extra}), {mode: 0o600});
  return {publicKeyFile, provenanceFile};
}
test('production readiness validates only secure-local public identity and redacts output', async (t) => {
  const {productionReadiness} = await import(script);
  const root = temporary(t), evidenceRoot = join(root, 'evidence');
  const result = productionReadiness({...publicIdentity(root), evidenceRoot});
  assert.equal(result.status, 'ready');
  assert.equal(result.productionEnabled, true);
  const text = readFileSync(join(evidenceRoot, 'production-readiness.json'), 'utf8');
  assert.ok(!text.includes(root));
  assert.doesNotMatch(text, /RW|public.key|PRIVATE KEY/);
  const invalid = publicIdentity(root, {purpose: 'platform-code-signing'});
  assert.throws(() => productionReadiness({...invalid, evidenceRoot}));
  const rejected = JSON.parse(readFileSync(join(evidenceRoot, 'production-readiness.json')));
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.productionEnabled, false);
});
test('fixture signatures reject tampered trusted comment and fixture metadata as payload', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.api.signFixture({...f.options, payloadFile: join(f.root, 'signer-private.pem')}));
  f.api.signFixture(f.options);
  const signatureFile = join(f.evidenceRoot, 'payload.sig');
  const text = Buffer.from(readFileSync(signatureFile, 'utf8'), 'base64').toString('utf8');
  chmodSync(signatureFile, 0o600);
  writeFileSync(signatureFile, Buffer.from(text.replace('version:9.8.7-beta.1', 'version:9.8.8')).toString('base64'));
  assert.throws(() => f.api.verifyFixture(f.options));
});
test('bounded CLI initializes, signs and verifies one run and reports public identity pending', (t) => {
  const root = temporary(t), evidenceRoot = join(root, 'evidence');
  const env = {...process.env}; delete env.NODE_TEST_CONTEXT;
  const call = (args) => spawnSync(process.execPath, [fileURLToPath(script), ...args], {encoding: 'utf8', env});
  const common = ['--run-root', root, '--evidence-root', evidenceRoot, '--version', identity.version, '--platform', identity.platform, '--arch', identity.arch];
  let result = call(['fixture-init', ...common]);
  assert.equal(result.status, 0, result.stderr);
  const init = JSON.parse(result.stdout);
  const payloadFile = join(root, 'fictional-cli.bin'); writeFileSync(payloadFile, 'CLI synthetic freshly built payload');
  result = call(['sign', ...common, '--payload-file', payloadFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).fingerprint, init.fingerprint);
  result = call(['verify', ...common, '--payload-file', payloadFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'verified');
  result = call(['production-readiness', '--evidence-root', evidenceRoot]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'pending_external_identity');
  result = call(['production-readiness', '--private-key-file', 'forbidden-private-input', '--evidence-root', evidenceRoot]);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /forbidden-private-input|PRIVATE KEY/);
});
test('production rejects TEST-ONLY, Ripple, platform signing, wrong fingerprint, insecure and symlink identities', async (t) => {
  const f = await fixture(t);
  const files = publicIdentity(f.root);
  for (const change of [{product: 'Ripple'}, {mode: 'TEST-ONLY-THROWAWAY'}, {purpose: 'platform-code-signing'}, {independent: false}, {fingerprint: 'a'.repeat(64)}, {owner: ''}]) {
    const changed = publicIdentity(f.root, change);
    assert.throws(() => f.api.productionReadiness({...changed, evidenceRoot: f.evidenceRoot}));
  }
  const valid = publicIdentity(f.root);
  assert.throws(() => f.api.productionReadiness({...valid, publicKeyFile: join(f.root, 'signer-public.key'), evidenceRoot: f.evidenceRoot}));
  // Windows owner access is governed by ACLs, not chmod mode bits.
  if (process.platform !== 'win32') {
    chmodSync(valid.publicKeyFile, 0o666);
    assert.throws(() => f.api.productionReadiness({...valid, evidenceRoot: f.evidenceRoot}));
    chmodSync(valid.publicKeyFile, 0o600);
  }
  const link = join(f.root, 'public-link'); symlinkSync(valid.publicKeyFile, link);
  assert.throws(() => f.api.productionReadiness({...valid, publicKeyFile: link, evidenceRoot: f.evidenceRoot}));
  assert.throws(() => f.api.productionReadiness({...files, evidenceRoot: process.cwd()}));
});

test('known Ripple raw public key stays rejected with rewritten Leaf comment and provenance', async (t) => {
  const {productionReadiness} = await import(script);
  const root = temporary(t);
  const files = publicIdentity(root, {fingerprint: '63f8a5f81fa7f5bce2e1ba0f18f6de3b27361e3f877ff1e1c796a1c3369407f7'});
  // Public reference identity only, never a private signing fixture.
  const raw = Buffer.from("RWQ0VhFl9rKWIiX2RJ/dHt4uefKBDH0qRr4+q0+UZJnFMr0Krz62Nw8r", 'base64');
  assert.equal(createHash('sha256').update(raw.subarray(10)).digest('hex'), '63f8a5f81fa7f5bce2e1ba0f18f6de3b27361e3f877ff1e1c796a1c3369407f7');
  const renamed = 'untrusted comment: Leaf independent updater public key\n' + raw.toString('base64') + '\n';
  writeFileSync(files.publicKeyFile, Buffer.from(renamed).toString('base64'));
  assert.throws(() => productionReadiness({...files, evidenceRoot: join(root, 'evidence')}), /Ripple/);
});
