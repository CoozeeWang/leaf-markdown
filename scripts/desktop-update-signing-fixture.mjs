// TEST-ONLY fixture generation and public-identity readiness. Never use this
// verifier in the product: native package verification uses official Tauri.
import {createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const contract = JSON.parse(readFileSync(new URL('../tests/fixtures/desktop-updates/trust-contract.json', import.meta.url)));
const MODE = contract.fixtureMode;
const MAX_PAYLOAD = 512 * 1024 * 1024;
const REPO = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => { const rel = relative(root, path); return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel); };
const check = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function ownerPrivate(path, directory = false) {
  const s = lstatSync(path);
  check(!s.isSymbolicLink() && (directory ? s.isDirectory() : s.isFile()), 'regular private local path required');
  check(process.platform === 'win32' || ((s.mode & 0o022) === 0 && (typeof process.getuid !== 'function' || s.uid === process.getuid())), 'local path is not owner controlled');
  return s;
}
function readBounded(path, max = 65536) {
  const s = ownerPrivate(path);
  check(s.size <= max && s.nlink === 1, 'local input exceeds limit or has multiple links');
  return readFileSync(path);
}
function writeOnce(path, value, mode = 0o400) {
  writeFileSync(path, value, {flag: 'wx', mode});
}
function disposableRoot(path, empty = false) {
  check(typeof path === 'string' && path.length > 0, 'run root required');
  ownerPrivate(path, true);
  const root = realpathSync(path);
  check(inside(realpathSync(tmpdir()), root) && /^leaf-update-test-[A-Za-z0-9_-]+$/.test(basename(root)), 'disposable temporary run root required');
  check((statSync(root).mode & 0o077) === 0 || process.platform === 'win32', 'run root must be private');
  if (empty) check(readdirSync(root).length === 0, 'run root must be empty');
  return root;
}
function evidenceDirectory(path, runRoot) {
  check(typeof path === 'string' && path.length > 0, 'evidence root required');
  const absolute = resolve(path);
  const proposed = join(realpathSync(dirname(absolute)), basename(absolute));
  check(proposed !== REPO && !inside(REPO, proposed), 'evidence must remain outside product repository');
  if (runRoot) check(inside(runRoot, proposed), 'fixture evidence must remain inside run root');
  if (!existsSync(proposed)) mkdirSync(proposed, {mode: 0o700});
  ownerPrivate(proposed, true);
  const root = realpathSync(proposed);
  check(root !== REPO && !inside(REPO, root) && (!runRoot || inside(runRoot, root)), 'unsafe evidence root');
  return root;
}
function identity(options) {
  const {version, platform, arch} = options;
  check(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/.test(version || ''), 'strict synthetic product version required');
  check(['darwin', 'windows', 'linux'].includes(platform) && ['aarch64', 'x86_64'].includes(arch), 'supported platform and architecture required');
  return {version, platform, arch};
}
function decode64(text) {
  check(typeof text === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text) && text.length > 0, 'invalid base64');
  return Buffer.from(text, 'base64');
}
function publicIdentity(text) {
  let content = text.trim();
  if (!content.startsWith('untrusted comment: ')) content = decode64(content).toString('utf8').trim();
  const lines = content.split(/\r?\n/);
  check(lines.length === 2 && lines[0].startsWith('untrusted comment: '), 'minisign public identity required');
  const block = decode64(lines[1]);
  check(block.length === 42 && block.subarray(0, 2).toString() === 'Ed', 'unsupported public identity');
  const raw = block.subarray(10);
  return {fingerprint: hash(raw), keyId: block.subarray(2, 10), comment: lines[0], key: createPublicKey({format: 'der', type: 'spki', key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])})};
}
function manifestFor(root) {
  const manifest = JSON.parse(readBounded(join(root, 'run-manifest.json')));
  const pub = publicIdentity(readBounded(join(root, 'signer-public.key')).toString());
  const signature = decode64(readBounded(join(root, 'run-manifest.sig')).toString());
  check(manifest.mode === MODE && manifest.fingerprint === pub.fingerprint && pub.keyId.toString() === contract.fixtureKeyId, 'fixture identity mismatch');
  check(verify(null, Buffer.from(JSON.stringify(manifest)), pub.key, signature), 'run manifest authentication failed');
  return {manifest, pub};
}
export function fixtureInit(options) {
  const root = disposableRoot(options.runRoot, true);
  const id = identity(options);
  const evidenceRoot = evidenceDirectory(options.evidenceRoot, root);
  // An empty root proves no payload predates this run. Never import a signer.
  const pair = generateKeyPairSync('ed25519');
  const raw = pair.publicKey.export({format: 'der', type: 'spki'}).subarray(-32);
  const fingerprint = hash(raw);
  const manifest = {schema: 1, mode: MODE, runId: randomUUID(), fingerprint, createdMs: Date.now(), ...id};
  const publicText = `untrusted comment: ${MODE} Leaf updater fixture\n${Buffer.concat([Buffer.from('EdTESTONLY'), raw]).toString('base64')}\n`;
  writeOnce(join(root, 'signer-private.pem'), pair.privateKey.export({format: 'pem', type: 'pkcs8'}), 0o600);
  writeOnce(join(root, 'signer-public.key'), Buffer.from(publicText).toString('base64'));
  writeOnce(join(root, 'run-manifest.json'), JSON.stringify(manifest));
  writeOnce(join(root, 'run-manifest.sig'), sign(null, Buffer.from(JSON.stringify(manifest)), pair.privateKey).toString('base64'));
  writeOnce(join(evidenceRoot, 'fixture-provenance.json'), JSON.stringify({schema: 1, mode: MODE, runId: manifest.runId, fingerprint, ...id}));
  return {status: 'initialized', mode: MODE, runId: manifest.runId, fingerprint};
}
function payloadFor(options, root, manifest, fresh = false) {
  check(same(identity(options), {version: manifest.version, platform: manifest.platform, arch: manifest.arch}), 'payload identity differs from run');
  const s = ownerPrivate(options.payloadFile);
  const file = realpathSync(options.payloadFile);
  const evidence = realpathSync(options.evidenceRoot);
  check(inside(root, file) && !inside(evidence, file) && s.nlink === 1, 'payload must be a regular single-link run artifact');
  check(!['signer-private.pem', 'signer-public.key', 'run-manifest.json', 'run-manifest.sig', 'payload-binding.json'].includes(relative(root, file)), 'fixture metadata cannot be a payload');
  check(s.size > 0 && s.size <= MAX_PAYLOAD, 'payload size out of bounds');
  check(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(basename(file)), 'simple synthetic payload filename required');
  if (fresh) check(s.birthtimeMs >= manifest.createdMs && s.mtimeMs >= manifest.createdMs, 'payload predates initialized run');
  const bytes = readFileSync(file);
  return {bytes, binding: {mode: MODE, runId: manifest.runId, fingerprint: manifest.fingerprint, version: manifest.version, platform: manifest.platform, arch: manifest.arch, sha256: hash(bytes), size: bytes.length, file: relative(root, file)}};
}
function trustedComment(binding) {
  return `timestamp:0\tfile:${basename(binding.file)}\tversion:${binding.version}\tmode:${MODE}\trun:${binding.runId}\tplatform:${binding.platform}\tarch:${binding.arch}\tsha256:${binding.sha256}\tbinding:${hash(JSON.stringify(binding))}`;
}
export function signFixture(options) {
  const root = disposableRoot(options.runRoot);
  const {manifest, pub} = manifestFor(root);
  const {bytes, binding} = payloadFor(options, root, manifest, true);
  const evidenceRoot = evidenceDirectory(options.evidenceRoot, root);
  const key = createPrivateKey(readBounded(join(root, 'signer-private.pem')));
  check(hash(createPublicKey(key).export({format: 'der', type: 'spki'}).subarray(-32)) === pub.fingerprint, 'signer changed');
  // Atomic exclusive creation claims the run before any signature can escape.
  writeOnce(join(root, 'payload-binding.json'), JSON.stringify(binding));
  const signature = sign(null, createHash('blake2b512').update(bytes).digest(), key);
  const comment = trustedComment(binding);
  const globalSignature = sign(null, Buffer.concat([signature, Buffer.from(comment)]), key);
  const minisign = `untrusted comment: ${MODE}\n${Buffer.concat([Buffer.from('ED'), pub.keyId, signature]).toString('base64')}\ntrusted comment: ${comment}\n${globalSignature.toString('base64')}\n`;
  writeOnce(join(evidenceRoot, 'payload.sig'), Buffer.from(minisign).toString('base64'));
  const evidence = {schema: 1, status: 'signed', ...binding, format: contract.fixtureFormat, officialVerifier: 'pending_plan_17_03'};
  writeOnce(join(evidenceRoot, 'fixture-evidence.json'), JSON.stringify(evidence));
  return evidence;
}
export function verifyFixture(options) {
  const root = disposableRoot(options.runRoot);
  const {manifest, pub} = manifestFor(root);
  const {bytes, binding} = payloadFor(options, root, manifest);
  check(same(JSON.parse(readBounded(join(root, 'payload-binding.json'))), binding), 'immutable payload binding changed');
  const evidenceRoot = evidenceDirectory(options.evidenceRoot, root);
  const lines = decode64(readBounded(join(evidenceRoot, 'payload.sig')).toString().trim()).toString('utf8').trim().split('\n');
  check(lines.length === 4 && lines[0] === `untrusted comment: ${MODE}`, 'fixture signature required');
  const block = decode64(lines[1]);
  check(block.length === 74 && block.subarray(0, 2).toString() === 'ED' && block.subarray(2, 10).equals(pub.keyId), 'signature identity mismatch');
  const signature = block.subarray(10);
  const comment = trustedComment(binding);
  check(lines[2] === `trusted comment: ${comment}`, 'authenticated metadata mismatch');
  check(verify(null, createHash('blake2b512').update(bytes).digest(), pub.key, signature) && verify(null, Buffer.concat([signature, Buffer.from(comment)]), pub.key, decode64(lines[3])), 'fixture signature failed');
  return {status: 'verified', mode: MODE, runId: manifest.runId, fingerprint: pub.fingerprint, officialVerifier: 'pending_plan_17_03'};
}
export function productionReadiness(options) {
  const evidenceRoot = evidenceDirectory(options.evidenceRoot);
  const reentry = 'node scripts/desktop-update-signing-fixture.mjs production-readiness --public-key-file <secure-local-public-key> --provenance-file <secure-local-provenance> --evidence-root <private-evidence-root>';
  const missing = !options.publicKeyFile || !options.provenanceFile || !existsSync(options.publicKeyFile) || !existsSync(options.provenanceFile);
  let result = {schema: 1, mode: 'production', status: 'pending_external_identity', productionEnabled: false, owner: contract.productionOwner, reentry};
  const target = join(evidenceRoot, 'production-readiness.json');
  if (existsSync(target)) ownerPrivate(target);
  // Invalidate an earlier ready result before revalidation; a rejected retry
  // cannot leave stale readiness available to downstream consumers.
  writeFileSync(target, JSON.stringify({...result, status: missing ? result.status : 'rejected'}), {mode: 0o600});
  if (!missing) {
    for (const file of [options.publicKeyFile, options.provenanceFile]) {
      ownerPrivate(dirname(file), true);
      const resolved = realpathSync(file);
      check(resolved !== REPO && !inside(REPO, resolved), 'production identity must be secure-local outside repository');
    }
    const pub = publicIdentity(readBounded(options.publicKeyFile).toString());
    const provenance = JSON.parse(readBounded(options.provenanceFile));
    check(pub.keyId.toString() !== contract.fixtureKeyId && !/TEST-ONLY|Ripple/i.test(pub.comment) && !contract.blockedPublicFingerprints.includes(pub.fingerprint), 'fixture or Ripple identity is forbidden');
    for (const [key, value] of Object.entries(contract.productionProvenance)) {
      check(provenance[key] === (key === 'fingerprint' ? pub.fingerprint : value), 'independent attributed Leaf public provenance required');
    }
    result = {schema: 1, mode: 'production', status: 'ready', productionEnabled: true, fingerprint: pub.fingerprint, owner: contract.productionOwner};
  }
  // Fixed redacted fields only; never echo paths, public key contents or input.
  writeFileSync(target, JSON.stringify(result), {mode: 0o600});
  return result;
}

export function runSigningCommand(argv) {
  const [command, ...args] = argv;
  const methods = {'fixture-init': fixtureInit, sign: signFixture, verify: verifyFixture, 'production-readiness': productionReadiness};
  check(Object.hasOwn(methods, command), 'unsupported signing command');
  const allowed = command === 'production-readiness' ? ['public-key-file', 'provenance-file', 'evidence-root'] : ['run-root', 'evidence-root', 'version', 'platform', 'arch', ...(command === 'fixture-init' ? [] : ['payload-file'])];
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].replace(/^--/, '');
    const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    check(args[i].startsWith('--') && allowed.includes(name) && !Object.hasOwn(options, key) && args[i + 1] && !args[i + 1].startsWith('--'), 'invalid signing arguments');
    options[key] = args[i + 1];
  }
  return methods[command](options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(runSigningCommand(process.argv.slice(2)))); }
  catch { console.error(JSON.stringify({status: 'rejected', reason: 'signing fixture or public identity validation failed'})); process.exitCode = 1; }
}
