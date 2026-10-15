import { mkdirSync, copyFileSync, writeFileSync, renameSync,chmodSync,statSync } from 'node:fs';
import {spawnSync} from 'node:child_process';
import {stageAdapter} from './build-mcp-adapter.mjs';
import { fileURLToPath } from 'node:url';
import { join,resolve } from 'node:path';

// Cargo's runner keeps native development inside a recognizable app bundle.
// No installer or Launch Services registration is involved. The executable is
// refreshed each time Cargo rebuilds, while the app identity remains stable.
export async function stageDevBundle({source,helper,test=false,launch=false,testBundlePath}={}) {
if(process.platform!=='darwin')throw new Error('macOS Dev bundle required');
const staged=await stageAdapter({debug:true,nativeSmoke:test,reuseBuild:!!helper||test});
if(helper&&resolve(helper)!==resolve(staged.binary))throw new Error('Dev helper must come from the native staging gate');
helper=staged.binary;
const identity=path=>{
  const result=spawnSync(path,['--leaf-build-identity'],{encoding:'utf8',timeout:5000});
  if(result.status!==0||!result.stdout.trim())throw new Error('Dev executable identity unavailable');return result.stdout.trim();
};
const guiIdentity=identity(source);const helperIdentity=identity(helper);
if(guiIdentity!==helperIdentity)throw new Error('Dev GUI/helper build identities differ');
if(testBundlePath&&!test)throw new Error('Disposable bundle path requires isolated native testing');
const bundle = testBundlePath ? resolve(testBundlePath) : fileURLToPath(new URL('../.cache/Leaf Dev.app/', import.meta.url));
const contents = join(bundle, 'Contents');
const executable = join(contents, 'MacOS', 'leaf');
mkdirSync(join(contents, 'MacOS'), { recursive: true });
mkdirSync(join(contents, 'Resources'), { recursive: true });
// Replace the inode rather than overwrite a signed executable in place:
// macOS can retain the old code-signing pages and kill the next launch.
copyFileSync(source, `${executable}.next`);
renameSync(`${executable}.next`, executable);
const adapter=join(contents,'MacOS','leaf-mcp-adapter');
copyFileSync(helper,`${adapter}.next`);renameSync(`${adapter}.next`,adapter);
chmodSync(executable,0o755);chmodSync(adapter,0o755);
copyFileSync(fileURLToPath(new URL('../src-tauri/icons/icon.icns', import.meta.url)), join(contents, 'Resources', 'icon.icns'));
writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${test?'studio.leaf.editor.dev.mcptest':'studio.leaf.editor.dev'}</string>
<key>CFBundleName</key><string>Leaf Dev</string>
<key>CFBundleDisplayName</key><string>Leaf Dev</string>
<key>CFBundleExecutable</key><string>leaf</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`);
// Replace the runner process so Tauri watches/kills the native app itself.
// Spawning a child here leaves an orphan window when Tauri kills the runner.
if(test)for(const path of [adapter,bundle]) {
  if(spawnSync('/usr/bin/codesign',['--force','--sign','-',path],{encoding:'utf8'}).status!==0)throw new Error('Dev test signing failed');
}
const result={bundle,executable,helper:adapter,identifier:test?'studio.leaf.editor.dev.mcptest':'studio.leaf.editor.dev',gui_inode:statSync(executable).ino,helper_inode:statSync(adapter).ino,gui_build_identity:identity(executable),helper_build_identity:identity(adapter)};
if(result.gui_build_identity!==guiIdentity||result.helper_build_identity!==helperIdentity)throw new Error('Dev staging changed an executable identity');
if(launch)process.execve(executable, [executable, ...process.argv.slice(3)], process.env);
return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv[2]==='--stage-for-test')console.log(JSON.stringify(await stageDevBundle({source:process.argv[3],test:true})));
  else {
    if(process.env.LEAF_DESKTOP_DEV!=='1'||!process.argv[2])throw new Error('Use the managed desktop:dev entry point.');
    await stageDevBundle({source:process.argv[2],launch:true});
  }
}
