// Actual Leaf GUI/profile evidence stays separate from synthetic bundle tests.
const categories=Object.freeze(['application','language','theme','bodyFonts','layout','savePreferences','recentFiles','namedDrafts','untitledDrafts','recoveryRecords','webviewStorage','connectionConfig']);
const fail=()=>{throw Error('installed_preservation_evidence_invalid');};
export function verifyInstalledPreservation(report){
  if(report?.pass!==true||report.layer!=='isolated-installed-leaf'||report.platform!=='darwin'||report.actual_leaf_gui!==true||report.synthetic_app_bundle!==false
    ||typeof report.from_version!=='string'||typeof report.to_version!=='string'||report.from_version===report.to_version
    ||!Array.isArray(report.actual_categories)||report.actual_categories.length!==categories.length
    ||categories.some(category=>report.actual_categories.filter(value=>value===category).length!==1))fail();
  for(const[phase,expected,restarts,state]of [['success',report.to_version,1,'installed'],['rollback',report.from_version,0,'rolled_back']]){
    const value=report[phase];
    if(value?.pass!==true||value.version!==expected||value.actual_helper!==true||value.actual_restart!==restarts||value.reconciled_state!==state
      ||value.comparison?.pass!==true||!Array.isArray(value.comparison.changed)||value.comparison.changed.length
      ||value.credential?.present!==true||value.credential.usable!==true)fail();
    if(phase==='success'&&value.actual_exit!==1)fail();
    if(phase==='rollback'&&(value.manual_relaunch!==1||value.old_bundle_verified!==true))fail();
  }
  return report;
}

import {randomBytes,createHash} from 'node:crypto';
import {chmodSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,readlinkSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {fixtureInit,signFixture} from '../scripts/desktop-update-signing-fixture.mjs';
import {captureProfile,compareProfiles,readProfileFile} from './desktop-updates-preservation.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function command(program,args,env=process.env){
 const child=spawnSync(program,args,{encoding:'utf8',timeout:120000,maxBuffer:1024*1024,env});
 if(child.error||child.status!==0)throw Error('installed_fixture_command_'+basename(program));
 return child.stdout.trim();
}
function inventory(root){
 const rows=[];
 const walk=(path,name)=>{
  const stat=lstatSync(path);
  if(stat.isSymbolicLink())rows.push({path:name,kind:'symlink',size:0,sha256:null,target:readlinkSync(path),executable:false});
  else if(stat.isDirectory()){rows.push({path:name,kind:'directory',size:0,sha256:null,target:null,executable:false});for(const child of readdirSync(path).sort())walk(join(path,child),name+'/'+child);}
  else if(stat.isFile())rows.push({path:name,kind:'file',size:stat.size,sha256:hash(readFileSync(path)),target:null,executable:Boolean(stat.mode&0o111)});
  else throw Error('installed_fixture_inventory');
 };
 walk(root,'Leaf.app');return rows;
}
function appVersion(app){
 command('/usr/bin/codesign',['--verify','--deep','--strict','--all-architectures',app]);
 const version=command('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',join(app,'Contents/Info.plist')]);
 if(!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version))throw Error('installed_fixture_version');
 for(const role of ['leaf','leaf-mcp-adapter','leaf-update-helper']){
  const bytes=readFileSync(join(app,'Contents/MacOS',role));
  if(!bytes.includes(Buffer.from('LEAF_UPDATE_BINARY_IDENTITY_V1\0Leaf\0studio.leaf.editor\0'+version+'\0'+role+'\0')))throw Error('installed_fixture_real_binary_identity');
 }
 const identity=command(join(app,'Contents/MacOS/leaf-update-helper'),['--leaf-build-identity']).split(':');
 if(identity[0]!==version||identity[4]!=='native-smoke')throw Error('installed_fixture_native_feature_required');
 return version;
}
function optionalJson(path){try{return JSON.parse(readFileSync(path));}catch{return null;}}
function privateJson(path,value){writeFileSync(path,JSON.stringify(value),{flag:'wx',mode:0o600});}
async function until(root,predicate,label,timeout=180000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){
  if(existsSync(join(root,'preservation-failure.json'))){const value=JSON.parse(readFileSync(join(root,'preservation-failure.json')));throw Error('installed_native_'+value.error);}
  const result=await predicate();if(result)return result;
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 throw Error('installed_fixture_timeout_'+label);
}
function nativeProcess(binary,args,env,logs){
 const child=spawn(binary,args,{env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',bytes=>logs.stdout.push(bytes));child.stderr.on('data',bytes=>logs.stderr.push(bytes));
 child.on('error',error=>{logs.error=error.code??'spawn';});
 return child;
}
function operation(root){
 const parent=join(root,'installed');
 for(const name of readdirSync(parent).filter(name=>name.startsWith('.leaf-update-'))){
  const path=join(parent,name,'plan.json');
  if(existsSync(path)&&existsSync(join(parent,name,'result.json'))){
   try{const plan=JSON.parse(readFileSync(path));const result=JSON.parse(readFileSync(plan.journal));if(['installed','rolled_back','install_failed','rollback_failed'].includes(result.state))return {path,plan,result,digest:readFileSync(join(parent,name,'plan.sha256'),'utf8')};}catch{}
  }
 }
 return null;
}
async function request(control,token,path,body={}){
 const response=await fetch(control.address+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw Error('installed_native_control_'+response.status);
 return response.json();
}
async function scenario({kind,oldApp,newApp,fromVersion,toVersion,evidenceRoot}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'leaf-update-test-')));chmodSync(root,0o700);
 const logs={stdout:[],stderr:[]},owned=[];let resumedControl,controlToken,first;
 try{
  const evidence=join(root,'evidence'),options={runRoot:root,evidenceRoot:evidence,version:toVersion,platform:'darwin',arch:process.arch==='arm64'?'aarch64':process.arch};
  const initialized=fixtureInit(options),salt=randomBytes(32).toString('hex'),credential=randomBytes(32).toString('hex');controlToken=randomBytes(32).toString('hex');
  mkdirSync(join(root,'installed'),{mode:0o700});command('/usr/bin/ditto',[oldApp,join(root,'installed/Leaf.app')]);
  const payloadRoot=join(root,'payload');mkdirSync(payloadRoot,{mode:0o700});const prepared=join(payloadRoot,'Leaf.app');
  command('/usr/bin/ditto',[newApp,prepared]);
  privateJson(join(payloadRoot,'leaf-update.json'),{schema:1,product:'Leaf',identifier:'studio.leaf.editor',version:toVersion,platform:'darwin',arch:options.arch,root:'Leaf.app',inventory:inventory(prepared)});
  // Match the native helper fixture without host-specific PAX metadata.
  const payload=join(root,'Leaf-preservation.tar.gz');command('/usr/bin/tar',['-czf',payload,'--format=ustar','--no-xattrs','--no-acls','--no-fflags','-C',payloadRoot,'leaf-update.json','Leaf.app'],{...process.env,COPYFILE_DISABLE:'1'});chmodSync(payload,0o600);
  signFixture({...options,payloadFile:payload});
  privateJson(join(root,'preservation-seed.json'),{run_id:initialized.runId,control_token:controlToken,credential});
  const env={...process.env,LEAF_UPDATE_PRESERVATION_ROOT:root,LEAF_UPDATE_PACKAGE_TEST_ROOT:root,LEAF_UPDATE_PRESERVATION_SCENARIO:kind};
  const binary=join(root,'installed/Leaf.app/Contents/MacOS/leaf');
  first=nativeProcess(binary,['--mac-update-preservation-smoke'],env,logs);owned.push(first);
  const beforeControl=await until(root,()=>optionalJson(join(root,'control-before.json')),'before');
  if(beforeControl.version!==fromVersion||beforeControl.resumed!==false||beforeControl.pid!==first.pid)throw Error('installed_before_identity');
  const profileBefore=await readProfileFile(root,'profile-before.json');
  const before=await captureProfile({runId:initialized.runId,snapshotId:kind+'-before',phase:'before',profile:profileBefore,salt,credential,
   probeCredential:challenge=>request(beforeControl,controlToken,'/credential',{challenge}),evidenceRoot});
  await until(root,async()=>{const status=await request(beforeControl,controlToken,'/status');if(['check_failed','no_package','current'].includes(status.state))throw Error('installed_update_catalog_'+status.state);return status.state==='available';},'available');
  await request(beforeControl,controlToken,'/continue');
  const transaction=await until(root,async()=>{
   const finished=operation(root);if(finished)return finished;
   if(first.exitCode===null){
    let status;try{status=await request(beforeControl,controlToken,'/status');}catch{}
    if(status&&['check_failed','download_failed','prepare_failed','install_failed'].includes(status.state))throw Error('installed_'+status.state+'_'+(status.error_code??'unknown'));
   }
   return null;
  },'helper-result');
  if(transaction.result.state!==(kind==='success'?'installed':'rolled_back'))throw Error('installed_helper_state_'+transaction.result.state+'_'+transaction.result.error);
  if(kind==='rollback'){
   const reopened=nativeProcess(binary,['--leaf-update-reconcile',transaction.path,transaction.digest,transaction.plan.transaction],env,logs);owned.push(reopened);
  }
  resumedControl=await until(root,()=>optionalJson(join(root,'control-after.json')),'resumed-profile');
  const expected=kind==='success'?toVersion:fromVersion;
  if(resumedControl.version!==expected||resumedControl.resumed!==true||resumedControl.state!==(kind==='success'?'installed':'rolled_back'))throw Error('installed_resume_identity');
  const profileAfter=await readProfileFile(root,'profile-after.json');
  const after=await captureProfile({runId:initialized.runId,snapshotId:kind+'-after',phase:kind,profile:profileAfter,salt,credential,
   probeCredential:challenge=>request(resumedControl,controlToken,'/credential',{challenge}),evidenceRoot});
  const comparison=compareProfiles(before,after,{runId:initialized.runId,salt,fromVersion,toVersion});
  if(!comparison.pass)throw Error('installed_profile_changed_'+comparison.changed.join(','));
  const exit=JSON.parse(readFileSync(join(root,'actual-update-exit.json'))),confirmation=JSON.parse(readFileSync(join(root,'actual-confirmation.json')));
  const effects=await until(root,()=>{try{return JSON.parse(readFileSync(join(dirname(transaction.path),'preservation-effects.json')));}catch{return null;}},'helper-effects');
  if(exit.accepted_exit_requested!==1||exit.exit_events!==1||exit.committed!==true||exit.verified_package_consumed!==true
   ||confirmation.one_confirmation!==true||confirmation.actual_updater_visible!==true||confirmation.actual_platform_menu_dispatch!==true
   ||effects.exchanges!==(kind==='success'?1:2)||effects.restarts!==(kind==='success'?1:0)
   ||transaction.result.restart_count!==effects.restarts)throw Error('installed_actual_effects');
  const downloads=JSON.parse(readFileSync(join(root,'actual-download.json')));
  if(downloads.count<1||downloads.bytes!==lstatSync(payload).size||downloads.sha256!==hash(readFileSync(payload)))throw Error('installed_actual_download');
  if(readFileSync(join(root,'profile/First.md'),'utf8')!=='# First actual Leaf protected edit\n'
    ||readFileSync(join(root,'profile/Second.md'),'utf8')!=='# Second actual Leaf protected edit\n')throw Error('installed_saved_documents');
  const oldBundle=transaction.result.old_location;
  if(appVersion(oldBundle)!==fromVersion||appVersion(join(root,'installed/Leaf.app'))!==expected)throw Error('installed_verified_bundle_version');
  return {pass:true,version:expected,actual_helper:true,actual_restart:effects.restarts,actual_exit:1,
   reconciled_state:resumedControl.state,comparison,credential:after.credential,
   manual_relaunch:kind==='rollback'?1:0,old_bundle_verified:true,actual_exchanges:effects.exchanges,
   actual_saved_documents:2,one_confirmation:true,verified_package_consumed:true,actual_network_download:true};

 }finally{
  if(evidenceRoot){
   mkdirSync(evidenceRoot,{recursive:true});
   const operations=existsSync(join(root,'installed'))?readdirSync(join(root,'installed')).filter(name=>name.startsWith('.leaf-update-')).map(name=>{
    const directory=join(root,'installed',name),journal=optionalJson(join(directory,'result.json'));
    return {plan:existsSync(join(directory,'plan.json')),commit_authorized:existsSync(join(directory,'commit-authorized')),install_claim:existsSync(join(directory,'result.install-claim')),restart_claim:existsSync(join(directory,'result.restart-claim')),state:journal?.state??null,error:journal?.error??null,effects:optionalJson(join(directory,'preservation-effects.json'))};
   }):[];
   privateJson(join(evidenceRoot,kind+'-exit-observation.json'),{first_exit_code:first?.exitCode??null,first_signal:first?.signalCode??null,actual_exit:optionalJson(join(root,'actual-update-exit.json')),confirmation:optionalJson(join(root,'actual-confirmation.json')),operations});
  }
  if(resumedControl){try{await request(resumedControl,controlToken,'/finish');await until(root,()=>existsSync(join(root,'cleanup-exit.json')),'cleanup-exit',15000);}catch{}}
  for(const child of owned)if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);}
  if(evidenceRoot){
   mkdirSync(evidenceRoot,{recursive:true});
   // Runtime logs stay local to this synthetic, disposable fixture; never emit the seed/vault.
   writeFileSync(join(evidenceRoot,kind+'-stdout.log'),Buffer.concat(logs.stdout));
   writeFileSync(join(evidenceRoot,kind+'-stderr.log'),Buffer.concat(logs.stderr));
   if(existsSync(join(root,'actual-helper-stderr.log')))writeFileSync(join(evidenceRoot,kind+'-helper-stderr.log'),readFileSync(join(root,'actual-helper-stderr.log')));
  }
  rmSync(root,{recursive:true,force:true});
 }
}
export async function runInstalledPreservation({platform,oldApp,newApp,evidenceRoot}){
 if(platform!=='darwin'||process.platform!=='darwin')throw Error('actual Mac host required');
 if(!oldApp||!newApp||!evidenceRoot)throw Error('installed fixture requires old/new actual apps and evidence root');
 oldApp=realpathSync(oldApp);newApp=realpathSync(newApp);evidenceRoot=resolve(evidenceRoot);
 const fromVersion=appVersion(oldApp),toVersion=appVersion(newApp);
 if(fromVersion===toVersion)throw Error('installed fixture requires distinct compiled versions');
 const success=await scenario({kind:'success',oldApp,newApp,fromVersion,toVersion,evidenceRoot});
 const rollback=await scenario({kind:'rollback',oldApp,newApp,fromVersion,toVersion,evidenceRoot});
 const report=verifyInstalledPreservation({pass:true,layer:'isolated-installed-leaf',platform:'darwin',actual_leaf_gui:true,synthetic_app_bundle:false,
  from_version:fromVersion,to_version:toVersion,actual_categories:[...categories],credential_backend:'isolated-synthetic-runtime-vault',os_keychain_exercised:false,installed_daily_app:false,success,rollback});
 privateJson(join(evidenceRoot,'installed-result.json'),report);return report;
}
if(import.meta.url===pathToFileURL(resolve(process.argv[1]??'.')).href){
 const args=process.argv.slice(2),allowed=new Set(['--platform','--old-app','--new-app','--evidence-root']),values={};
 for(let index=0;index<args.length;index+=2){if(!allowed.has(args[index])||!args[index+1]||args[index+1].startsWith('--')||Object.hasOwn(values,args[index]))throw Error('unknown or incomplete installed fixture arguments');values[args[index]]=args[index+1];}
 if(args.length!==8)throw Error('installed fixture requires explicit platform, old app, new app and evidence root');
 console.log(JSON.stringify(await runInstalledPreservation({platform:values['--platform'],oldApp:values['--old-app'],newApp:values['--new-app'],evidenceRoot:values['--evidence-root']})));
}
