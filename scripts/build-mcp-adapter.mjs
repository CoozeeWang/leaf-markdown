import { spawn } from 'node:child_process';
import { mkdir, copyFile, chmod, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const env = { ...process.env, PATH: `${homedir()}/.cargo/bin:${process.env.PATH}` };
if (process.platform === 'darwin') env.LANG = env.LC_ALL = env.LC_CTYPE = 'en_US.UTF-8';
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', ...options });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`build failed (${code})`)));
  });
}
async function output(command, args) {
  return new Promise((resolve, reject) => {
    let value = ''; const child = spawn(command, args, { cwd: root, env });
    child.stdout.on('data', chunk => value += chunk); child.on('error', reject); child.on('exit', code => code === 0 ? resolve(value) : reject(new Error('target detection failed')));
  });
}
export async function stageAdapter({ target = 'current', debug = false, nativeSmoke = false, reuseBuild = false } = {}) {
  const host = (await output('rustc', ['-vV'])).match(/^host: (.+)$/m)?.[1]; assert(host);
  if (target === 'current') target = host;
  assert(/^[a-zA-Z0-9_.-]+$/.test(target), 'valid Rust target triple required');
  const suffix = target.includes('windows') ? '.exe' : '';
  // The helper's Cargo build must not depend on the sidecar it is producing.
  const cargoConfig = JSON.parse(env.TAURI_CONFIG || '{}'); cargoConfig.bundle = { ...cargoConfig.bundle, externalBin: [] };
  const buildEnv = { ...env, TAURI_CONFIG: JSON.stringify(cargoConfig) };
  if (target.includes('apple-darwin')) buildEnv.MACOSX_DEPLOYMENT_TARGET = debug ? '14.0' : '11.0';
  if(!reuseBuild)await run('cargo', ['build', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'leaf-mcp-adapter', ...(nativeSmoke ? ['--features','native-smoke'] : []), ...(debug ? [] : ['--release']), ...(target === host ? [] : ['--target', target])], { env: buildEnv });
  const binary = join(root, 'src-tauri/target', ...(target === host ? [] : [target]), debug ? 'debug' : 'release', `leaf-mcp-adapter${suffix}`);
  if(target===host) {
    const identity=(await output(binary,['--leaf-build-identity'])).trim();
    assert(identity.includes(nativeSmoke?':native-smoke:':':production:'),'helper feature identity must match the selected build');
  }
  const staging = join(root, 'src-tauri/binaries'); await mkdir(staging, { recursive: true });
  await copyFile(binary, join(staging, `leaf-mcp-adapter-${target}${suffix}`));
  if (!suffix) await chmod(join(staging, `leaf-mcp-adapter-${target}`), 0o755);
  return { target, host, suffix, binary };
}
export async function producePackages(options = {}) {
  const built = await stageAdapter({...options,nativeSmoke:!!options.testBundle||!!options.nativeSmoke});
  assert.equal(built.target, built.host, 'packaged launch proof requires a native build target');
  assert(['darwin', 'win32'].includes(process.platform), 'native package producer supports macOS and Windows');
  const cache = join(root, '.cache/mcp-adapter'); await mkdir(cache, { recursive: true });
  const cli = join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  let appName='Leaf';const extra=[];
  if (options.testBundle) {
    assert.equal(process.platform,'darwin','native package fixture currently runs on macOS');
    const config=JSON.parse(await readFile(join(root,'src-tauri/tauri.mcp-test.conf.json'),'utf8'));
    config.bundle={...config.bundle,active:true};appName=config.productName;
    const path=join(cache,'tauri-package-test.json');await writeFile(path,JSON.stringify(config));
    extra.push('--features','native-smoke','--config',path);
  }
  await run(process.execPath, [cli, 'build', '--bundles', process.platform === 'darwin' ? 'app' : 'nsis',...extra]);
  let appHelper;
  if (process.platform === 'darwin') {
    appHelper = join(root, `src-tauri/target/release/bundle/macos/${appName}.app/Contents/MacOS/leaf-mcp-adapter`);
  } else {
    // Tauri places a console externalBin beside its GUI exe before the NSIS producer.
    // The unpacked payload is the installation directory layout; installer UI is a
    // separate Windows platform acceptance layer.
    const payload = join(cache, 'windows-payload'); await mkdir(payload, { recursive: true });
    await copyFile(join(root, 'src-tauri/target/release/leaf.exe'), join(payload, 'leaf.exe'));
    await copyFile(join(root, 'src-tauri/target/release/leaf-mcp-adapter.exe'), join(payload, 'leaf-mcp-adapter.exe'));
    appHelper = join(payload, 'leaf-mcp-adapter.exe');
  }
  const stage = join(cache, 'mcpb-stage'); const unpacked = join(cache, 'mcpb-unpacked');
  await rm(stage, { recursive: true, force: true }); await rm(unpacked, { recursive: true, force: true });
  await mkdir(join(stage, 'server'), { recursive: true }); await mkdir(unpacked, { recursive: true });
  // Copy the actual bundled/signed executable, preserving its process identity.
  await copyFile(appHelper, join(stage, `server/leaf-mcp-adapter${built.suffix}`));
  if (!built.suffix) await chmod(join(stage, 'server/leaf-mcp-adapter'), 0o755);
  const manifest = JSON.parse(await readFile(join(root, 'packaging/mcpb/manifest.json'), 'utf8'));
  manifest.compatibility.platforms = [process.platform];
  if (built.suffix) manifest.server.entry_point += built.suffix;
  await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const archive = join(cache, `leaf-${built.target}.mcpb`); await rm(archive, { force: true });
  if (process.platform === 'darwin') {
    await run('/usr/bin/zip', ['-q', '-r', archive, 'manifest.json', 'server'], { cwd: stage });
    await run('/usr/bin/unzip', ['-q', archive, '-d', unpacked]);
  } else {
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const zip = archive + '.zip';
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path ${quote(join(stage, '*'))} -DestinationPath ${quote(zip)} -Force; Expand-Archive -Path ${quote(zip)} -DestinationPath ${quote(unpacked)} -Force`]);
    await copyFile(zip, archive); await rm(zip, { force: true });
  }
  const mcpbHelper = join(unpacked, `server/leaf-mcp-adapter${built.suffix}`);
  const workbuddy = { command: appHelper, args: ['--descriptor', '${LEAF_EXPORTED_WORKBUDDY_DESCRIPTOR}'] };
  await writeFile(join(cache, 'artifacts.json'), JSON.stringify({ target: built.target, appHelper, appExecutable:join(appHelper,'..','leaf'), testBundle:!!options.testBundle, mcpbHelper, archive, workbuddy }, null, 2) + '\n');
  console.log(`Produced Tauri sidecar and binary MCPB for ${built.target}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const index = args.indexOf('--target');
  const options = { target: index >= 0 ? args[index + 1] : (process.env.TAURI_ENV_TARGET_TRIPLE || 'current'), debug: args.includes('--debug'),testBundle:args.includes('--test-bundle') };
  try { if (args.includes('--stage-only')) await stageAdapter(options); else await producePackages(options); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
