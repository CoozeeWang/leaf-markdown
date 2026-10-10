import { mkdirSync, copyFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Cargo's runner keeps native development inside a recognizable app bundle.
// No installer or Launch Services registration is involved. The executable is
// refreshed each time Cargo rebuilds, while the app identity remains stable.
if (process.platform !== 'darwin' || process.env.LEAF_DESKTOP_DEV !== '1' || !process.argv[2]) {
  throw new Error('Use the managed desktop:dev entry point.');
}
const bundle = fileURLToPath(new URL('../.cache/Leaf Dev.app/', import.meta.url));
const contents = join(bundle, 'Contents');
const executable = join(contents, 'MacOS', 'leaf');
mkdirSync(join(contents, 'MacOS'), { recursive: true });
mkdirSync(join(contents, 'Resources'), { recursive: true });
// Replace the inode rather than overwrite a signed executable in place:
// macOS can retain the old code-signing pages and kill the next launch.
copyFileSync(process.argv[2], `${executable}.next`);
renameSync(`${executable}.next`, executable);
copyFileSync(fileURLToPath(new URL('../src-tauri/icons/icon.icns', import.meta.url)), join(contents, 'Resources', 'icon.icns'));
writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>studio.leaf.editor.dev</string>
<key>CFBundleName</key><string>Leaf Dev</string>
<key>CFBundleDisplayName</key><string>Leaf Dev</string>
<key>CFBundleExecutable</key><string>leaf</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`);
// Replace the runner process so Tauri watches/kills the native app itself.
// Spawning a child here leaves an orphan window when Tauri kills the runner.
process.execve(executable, [executable, ...process.argv.slice(3)], process.env);
