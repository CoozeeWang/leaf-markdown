import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('updater producer binds compiled identities and a complete inventory, rejects overwrite and unsafe links',()=>{
 const code=String.raw`
import importlib.util, tempfile, pathlib, json, tarfile
spec=importlib.util.spec_from_file_location('package_updater','scripts/package-updater.py')
api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);source=root/'Leaf';source.mkdir()
 for role in ['leaf','leaf-mcp-adapter','leaf-update-helper']:
  binary=source/(role+'.exe')
  binary.write_bytes(b'LEAF_UPDATE_BINARY_IDENTITY_V1\0Leaf\0studio.leaf.editor\0'+b'1.0.1\0'+role.encode()+b'\0')
  binary.chmod(0o700)
 output=root/'update.tar.gz';api.build(source,output,'1.0.1','windows','x86_64')
 with tarfile.open(output) as archive:
  metadata=json.load(archive.extractfile('leaf-update.json'))
  assert {item['path'] for item in metadata['inventory']}==set(archive.getnames())-{'leaf-update.json'}
  assert metadata['version']=='1.0.1'
 for target,version in [(output,'1.0.1'),(root/'wrong-version.tar.gz','1.0.2')]:
  try:api.build(source,target,version,'windows','x86_64');raise AssertionError('invalid production accepted')
  except ValueError:pass
 # Windows symlink creation may need a developer setting; run that boundary on Unix.
 import os
 if os.name!='nt':
  (source/'external').symlink_to(root/'missing')
  try:api.build(source,root/'unsafe.tar.gz','1.0.1','windows','x86_64');raise AssertionError('unsafe link accepted')
  except ValueError:pass
`;
 const result=spawnSync(process.platform==='win32'?'python':'python3',['-B','-c',code],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(result.status,0,result.stderr);
});
