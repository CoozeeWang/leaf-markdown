import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyInstalledPreservation} from './desktop-updates-installed.mjs';
const categories=['application','language','theme','bodyFonts','layout','savePreferences','recentFiles','namedDrafts','untitledDrafts','recoveryRecords','webviewStorage','connectionConfig'];
const report=()=>({pass:true,layer:'isolated-installed-leaf',platform:'darwin',actual_leaf_gui:true,synthetic_app_bundle:false,
  from_version:'0.4.0-beta.3',to_version:'0.4.0-beta.4',actual_categories:categories,
  success:{pass:true,version:'0.4.0-beta.4',actual_helper:true,actual_restart:1,actual_exit:1,reconciled_state:'installed',comparison:{pass:true,changed:[]},credential:{present:true,usable:true}},
  rollback:{pass:true,version:'0.4.0-beta.3',actual_helper:true,actual_restart:0,manual_relaunch:1,reconciled_state:'rolled_back',old_bundle_verified:true,comparison:{pass:true,changed:[]},credential:{present:true,usable:true}}});
test('installed evidence rejects synthetic app bundle as actual Leaf GUI preservation',()=>{
 const value=report();value.actual_leaf_gui=false;value.synthetic_app_bundle=true;
 assert.throws(()=>verifyInstalledPreservation(value),/installed_/);
});
test('installed evidence rejects missing actual persisted category despite passing oracle',()=>{
 const value=report();value.actual_categories=value.actual_categories.filter(name=>name!=='webviewStorage');
 assert.throws(()=>verifyInstalledPreservation(value),/installed_/);
});
test('installed evidence rejects missing real restart or unverified reconciliation',()=>{
 const value=report();value.success.actual_restart=0;value.success.reconciled_state='installing';
 assert.throws(()=>verifyInstalledPreservation(value),/installed_/);
});
test('installed evidence rejects rollback with changed version or no verified old bundle',()=>{
 const value=report();value.rollback.version=value.to_version;value.rollback.old_bundle_verified=false;
 assert.throws(()=>verifyInstalledPreservation(value),/installed_/);
});

test('installed evidence accepts complete actual success and verified rollback evidence',()=>{
 const value=report();assert.equal(verifyInstalledPreservation(value),value);
});


test('installed CLI rejects unsupported audit flags instead of empty success',()=>{
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('./desktop-updates-installed.mjs',import.meta.url)),'--verify-readiness'],{encoding:'utf8'});
 assert.notEqual(child.status,0);assert.match(child.stderr,/unknown or incomplete installed fixture arguments/);
});
