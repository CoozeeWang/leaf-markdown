// Verify the real macOS bundle, rather than only the input configuration.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const app=process.argv[2];
assert.ok(process.platform==='darwin'&&app?.endsWith('.app'),'Usage on macOS: node tests/document-icons-package.mjs path/to/Leaf.app');
const config=JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8'));
const plist=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',path.join(app,'Contents/Info.plist')],{encoding:'utf8'}));
assert.equal(plist.CFBundleIdentifier,config.identifier);
assert.equal(plist.CFBundleDocumentTypes.length,config.bundle.fileAssociations.length);
for(const [i,association] of config.bundle.fileAssociations.entries()) {
  const type=plist.CFBundleDocumentTypes[i];
  assert.deepEqual(type.CFBundleTypeExtensions,association.ext,'custom plist must retain every supported extension');
  assert.equal(type.CFBundleTypeRole,association.role);
  assert.equal(type.CFBundleTypeName,association.name);
  assert.equal(type.LSHandlerRank,association.rank??'Default','icon registration must not promote Leaf to owner');
  assert.equal(type.CFBundleTypeIconFile,plist.CFBundleIconFile,'document icon reuses the shipped Leaf brand');
  assert.equal(path.basename(type.CFBundleTypeIconFile),type.CFBundleTypeIconFile);
  const bytes=await readFile(path.join(app,'Contents/Resources',type.CFBundleTypeIconFile));
  assert.equal(bytes.toString('ascii',0,4),'icns');
  assert.equal(bytes.readUInt32BE(4),bytes.length);
  assert.deepEqual(bytes,await readFile(new URL('../src-tauri/icons/icon.icns',import.meta.url)));
  const chunks=[];
  for(let offset=8;offset<bytes.length;) {
    const size=bytes.readUInt32BE(offset+4);assert.ok(size>=8&&offset+size<=bytes.length);
    chunks.push(bytes.toString('ascii',offset,offset+4));offset+=size;
  }
  assert.ok(chunks.length>=3,'icon includes multiple native sizes');
}
console.log('PASS macOS package: unchanged document associations, bundled Leaf icon and multiple icon sizes');

assert.equal(plist.NSServices.length,1);
const service=plist.NSServices[0];
assert.equal(service.NSMessage,'leafNewMarkdown');
assert.equal(service.NSPortName,'Leaf');
assert.equal(service.NSMenuItem.default,'使用 Leaf 新建 Markdown 文档');
assert.deepEqual(service.NSSendTypes,['public.file-url']);
assert.equal(service.NSRequiredContext.NSApplicationIdentifier,'com.apple.finder');
console.log('PASS macOS package: Finder new Markdown service declaration');
