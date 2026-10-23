// Fresh, disposable, TEST-ONLY signed package fixtures. No product credentials.
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,truncateSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {fixtureInit,signFixture} from './desktop-update-signing-fixture.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const version='9.8.7-beta.1';
function binary(platform,arch,role,identityVersion=version) {
  const bytes=Buffer.alloc(256);
  if(platform==='darwin') {
    bytes.set([0xcf,0xfa,0xed,0xfe]);bytes.writeUInt32LE(arch==='aarch64'?0x0100000c:0x01000007,4);bytes.writeUInt32LE(2,12);
  } else {
    bytes.write('MZ');bytes.writeUInt32LE(128,60);bytes.write('PE\0\0',128);bytes.writeUInt16LE(arch==='aarch64'?0xaa64:0x8664,132);
    bytes.writeUInt16LE(2,150);bytes.writeUInt16LE(0x20b,152);
  }
  return Buffer.concat([bytes,Buffer.from(`LEAF_UPDATE_BINARY_IDENTITY_V1\0Leaf\0studio.leaf.editor\0${identityVersion}\0${role}\0`)]);
}
function header(path,kind,size=0,target='',mode=0o600) {
  const bytes=Buffer.alloc(512);
  const text=(offset,length,value)=>{const encoded=Buffer.from(value);if(encoded.length>length)throw Error('fixture header field overflow');encoded.copy(bytes,offset);};
  const octal=(offset,length,value)=>text(offset,length,value.toString(8).padStart(length-1,'0')+'\0');
  text(0,100,path);octal(100,8,mode);octal(108,8,0);octal(116,8,0);octal(124,12,size);octal(136,12,0);
  bytes.fill(32,148,156);bytes[156]=kind.charCodeAt(0);text(157,100,target);text(257,6,'ustar\0');text(263,2,'00');
  const sum=bytes.reduce((a,b)=>a+b,0);text(148,8,sum.toString(8).padStart(6,'0')+'\0 ');
  return bytes;
}
function archive(entries) {
  const chunks=[];
  for(const entry of entries) {
    const bytes=entry.bytes||Buffer.alloc(0);
    let name=entry.path;
    if(Buffer.byteLength(name)>100) {
      const long=Buffer.from(name+'\0');
      chunks.push(header('././@LongLink','L',long.length),long,Buffer.alloc((512-long.length%512)%512));name='long-path-entry';
    }
    chunks.push(header(name,entry.type||'0',entry.declaredSize??bytes.length,entry.target||'',entry.executable?0o700:0o600),bytes,Buffer.alloc((512-bytes.length%512)%512));
  }
  chunks.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(chunks));
}
function contents(platform,arch,scenario) {
  const root=platform==='darwin'?'Leaf.app':'Leaf';
  const entries=[];
  const dir=path=>entries.push({path,type:'5'});
  dir(root);
  let binRoot=root;
  if(platform==='darwin') {
    dir(root+'/Contents');dir(root+'/Contents/MacOS');dir(root+'/Contents/Resources');binRoot=root+'/Contents/MacOS';
    const info='<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>studio.leaf.editor</string><key>CFBundleShortVersionString</key><string>'+version+'</string><key>CFBundleExecutable</key><string>leaf</string></dict></plist>';
    entries.push({path:root+'/Contents/Info.plist',bytes:Buffer.from(info)});
    entries.push({path:root+'/Contents/Resources/data.txt',bytes:Buffer.from('Synthetic fresh update resource')});
  }
  for(const role of ['leaf','leaf-mcp-adapter']) {
    if(scenario==='missing-adapter'&&role==='leaf-mcp-adapter')continue;
    const binaryArch=scenario==='wrong-binary-arch'?(arch==='aarch64'?'x86_64':'aarch64'):arch;
    entries.push({path:binRoot+'/'+role+(platform==='windows'?'.exe':''),executable:true,
      bytes:binary(platform,binaryArch,role,scenario==='wrong-binary-version'?'9.8.6':version)});
  }
  if(platform==='darwin'&&['relative-link','escaping-link','cyclic-link','ancestor-link','sibling-link-cycle'].includes(scenario)) {
    const prefix=root+'/Contents/Resources/';
    entries.push({path:prefix+'current',type:'2',target:scenario==='escaping-link'?'../../../outside':scenario==='cyclic-link'?'other':scenario==='ancestor-link'?'.':'data.txt'});
    if(scenario==='cyclic-link')entries.push({path:prefix+'other',type:'2',target:'current'});
    if(scenario==='sibling-link-cycle') {
      dir(prefix+'A');dir(prefix+'B');
      entries.push({path:prefix+'A/toB',type:'2',target:'../B'},{path:prefix+'B/toA',type:'2',target:'../A'});
    }
  }
  if(['depth-exact','depth-over'].includes(scenario)) {
    let path=root;for(let i=0;i<(scenario==='depth-exact'?31:32);i++) {path+='/d'+i;dir(path);}
  }
  if(['entry-count-exact','entry-count-over'].includes(scenario)) {
    const target=scenario==='entry-count-exact'?19999:20000;
    while(entries.length<target)dir(root+'/count-'+entries.length);
  }
  if(scenario==='unicode-alias') {
    entries.push({path:root+'/caf\u00e9.txt',bytes:Buffer.from('one')},{path:root+'/cafe\u0301.txt',bytes:Buffer.from('two')});
  }
  const inventory=entries.map(entry=>({path:entry.path,kind:entry.type==='5'?'directory':entry.type==='2'?'symlink':'file',
    size:entry.bytes?.length||0,sha256:entry.bytes?hash(entry.bytes):null,target:entry.target||null,executable:entry.executable||false}));
  const metadata={schema:1,product:'Leaf',identifier:'studio.leaf.editor',version:scenario==='wrong-metadata-version'?'9.8.6':version,
    platform,arch,root,inventory};
  let metadataBytes=Buffer.from(JSON.stringify(metadata));
  if(scenario==='invalid-json-utf8')metadataBytes=Buffer.from([0xff,0xfe]);
  entries.unshift({path:'leaf-update.json',bytes:metadataBytes});
  if(scenario==='traversal')entries.push({path:'../outside',bytes:Buffer.from('synthetic escape')});
  if(scenario==='absolute')entries.push({path:'/outside',bytes:Buffer.from('synthetic escape')});
  if(scenario==='hardlink')entries.push({path:root+'/hardlink',type:'1',target:binRoot+'/leaf'});
  if(scenario==='fifo')entries.push({path:root+'/fifo',type:'6'});
  if(scenario==='duplicate')entries.push({...entries.at(-1)});
  if(scenario==='expanded-size-over')entries.push({path:root+'/large',declaredSize:2*1024*1024*1024+1});
  if(scenario==='path-size-over')entries.push({path:'Leaf/'+Array(31).fill('x'.repeat(131)).join('/')+'x',bytes:Buffer.from('too long')});
  return archive(entries);
}
const coordinatorCases=['empty_set_global_gate','native_saved_ledger','native_settled_snapshot','actual_reply_identity_matrix','partial_save_cancel','abort_draining_real_write','mcp_busy_and_finish','pending_and_queued_open','timeout_and_participant_loss','native_close_same_action','ordinary_quit_competition','native_save_as_rebind','handoff_failure_and_stale_permit','one_commit_real_exit'];
export function verifyCoordinatorReport(report) {
  const finalEffects=e=>e&&['destroy','install','restart','leaf_close','harness_exit','rejected_exit_requested'].every(key=>e[key]===0)&&e.exit===1&&e.accepted_exit_requested===1&&e.exit_events===1;
  const noEffects=e=>e&&['destroy','exit','install','restart','leaf_close','harness_exit','accepted_exit_requested','exit_events','rejected_exit_requested'].every(key=>e[key]===0);
  if(report?.pass!==true||report.layer!=='actual-tauri'||report.tracer!=='updates-coordinator'||report.executed!==coordinatorCases.length
    ||!Array.isArray(report.scenarios)||report.scenarios.length!==coordinatorCases.length||!finalEffects(report.side_effects)
    ||coordinatorCases.some(name=>report.scenarios.filter(row=>row.name===name&&row.pass===true).length!==1))throw Error('native coordinator report failed: '+(report?.error||'invalid evidence'));
  for(const row of report.scenarios) {
    if(row.name==='one_commit_real_exit') {
      if(!finalEffects(row.side_effects)||row.details?.actual_run_event_exit!==true||row.details.permit_consumptions!==1||row.details.verified_package_consumed!==true||row.details.installer_invocations!==0||row.details.restart_invocations!==0)throw Error('native coordinator final exit proof failed');
    } else if(!noEffects(row.side_effects))throw Error('native coordinator precommit effects: '+row.name);
  }
  return report;
}
export const prepareCases=Object.freeze(['two_dirty_latest_saved','partial_save_untitled_cancel','actual_checkpoint_failure','actual_save_failure','native_generation_fence','stale_selector_abort_retry','admitted_save_as_late_success','live_mcp_apply_and_finish','pending_finish_settlement','pending_start_and_queued_open','download_edits_new_document','wrong_duplicate_late_reply','save_as_native_rebind','live_ime_draft_abort','missed_begin_release_recovery','reload_mid_saved_abort','native_close_ordinary_quit_race','timeout_and_loss','native_menu_barrier_reopen','installer_not_ready_abort','one_confirmed_commit_real_exit']);
export function verifyPrepareReport(report) {
  const zero=e=>e&&['destroy','exit','install','restart','leaf_close','harness_exit','accepted_exit_requested','exit_events','rejected_exit_requested'].every(key=>e[key]===0);
  const final=e=>e&&['destroy','install','restart','leaf_close','harness_exit','rejected_exit_requested'].every(key=>e[key]===0)&&e.exit===1&&e.accepted_exit_requested===1&&e.exit_events===1;
  if(report?.pass!==true||report.layer!=='actual-tauri'||report.tracer!=='updates-prepare'||report.manual_driver!==false||report.production_listeners!==true
    ||report.syntheticChooser!==true||report.noOSDialogClaim!==true||report.executed!==prepareCases.length||!Array.isArray(report.scenarios)
    ||report.scenarios.length!==prepareCases.length||!final(report.side_effects))throw Error('native prepare report failed: '+(report?.error||'invalid evidence'));
  for(const [index,row]of report.scenarios.entries()){
    if(row.name!==prepareCases[index]||row.pass!==true)throw Error('native prepare cases incomplete, duplicated or unordered');
    if(index===prepareCases.length-1){
      const d=row.details;
      if(!final(row.side_effects)||d?.actual_run_event_exit!==true||d.permit_consumptions!==1||d.verified_package_consumed!==true||d.live_intent_required!==true
        ||d.actual_updater_confirmation!==true||d.production_prepare_loop!==true||d.production_participant_listeners!==true||d.synthetic_native_ready_channel!==true
        ||d.installer_invocations!==0||d.restart_invocations!==0)throw Error('native prepare final exit proof failed');
    }else if(!zero(row.side_effects))throw Error('native prepare precommit effects: '+row.name);
  }
  const details=name=>report.scenarios.find(row=>row.name===name).details;
  const download=details('download_edits_new_document'),reload=details('reload_mid_saved_abort');
  if(download?.download_state_fixture!==true||download.network_download_exercised!==false)throw Error('native prepare download scope misreported');
  if(reload?.actual_webview_reloaded_at_sealed!==true||reload.all_files_durable_before_reload!==true||reload.fresh_webview_global!==true
    ||reload.native_ready_generation_changed!==true||reload.mcp_registration_and_ordinary_editing_restored!==true||reload.latest_durable_content_retained!==true
    ||reload.dirty_unstaged_reload_claim!==false)throw Error('native prepare reload proof failed');
  if(details('live_ime_draft_abort')?.real_ime_acceptance!==false||details('timeout_and_loss')?.real_process_crash!==false)throw Error('native prepare synthetic scope misreported');
  return report;
}
export function runPackageFixtures(binaryPath,{races=false,coordinator=false,prepare=false}={}) {
  if([races,coordinator,prepare].filter(Boolean).length>1)throw Error('fixture modes are mutually exclusive');
  binaryPath=resolve(binaryPath);
  const platform=process.platform==='darwin'?'darwin':process.platform==='win32'?'windows':null;
  if(!platform)throw Error('Mac or Windows native fixture host required');
  const arch=process.arch==='arm64'?'aarch64':process.arch==='x64'?'x86_64':null;
  if(!arch)throw Error('supported native architecture required');
  const coordinatorReport=resolve('test-results/desktop-updates-native/coordinator-result.json');
  const prepareReport=resolve('test-results/desktop-updates-native/prepare-result.json');
  if(coordinator)rmSync(coordinatorReport,{force:true});
  if(prepare)rmSync(prepareReport,{force:true});
  const cases=races||coordinator||prepare?['valid']:['valid',...(platform==='darwin'?['relative-link','escaping-link','cyclic-link','ancestor-link','sibling-link-cycle']:[]),
    'tampered-payload','wrong-metadata-version','wrong-binary-version','wrong-binary-arch','missing-adapter','invalid-json-utf8','traversal','absolute','hardlink','fifo','duplicate','unicode-alias','expanded-size-over','path-size-over','depth-exact','depth-over','entry-count-exact','entry-count-over','download-size-over'];
  const results=[];
  for(const scenario of cases) {
    const root=mkdtempSync(join(tmpdir(),'leaf-update-test-'));
    try {
      const evidence=join(root,'evidence');
      const options={runRoot:root,evidenceRoot:evidence,version,platform,arch};
      fixtureInit(options); // Must precede this run's new payload build.
      const payload=join(root,'Leaf-synthetic.tar.gz');
      writeFileSync(payload,contents(platform,arch,scenario),{flag:'wx',mode:0o600});
      signFixture({...options,payloadFile:payload});
      if(scenario==='tampered-payload') {
        const bytes=readFileSync(payload);bytes[Math.floor(bytes.length/2)]^=1;writeFileSync(payload,bytes,{mode:0o600});
      }
      if(scenario==='download-size-over')truncateSync(payload,512*1024*1024+1);
      const expected=['valid','relative-link','depth-exact','entry-count-exact'].includes(scenario);
      const child=spawnSync(binaryPath,[prepare?'--update-prepare-smoke':coordinator?'--update-coordinator-smoke':races?'--update-package-races':'--update-package-smoke'],{encoding:'utf8',timeout:prepare?300000:coordinator?150000:90000,
        env:{...process.env,LEAF_UPDATE_PACKAGE_TEST_ROOT:root},maxBuffer:1024*1024});
      if(prepare||coordinator){
        const logs=resolve('test-results/desktop-updates-native');mkdirSync(logs,{recursive:true});
        const mode=prepare?'prepare':'coordinator';
        writeFileSync(join(logs,mode+'-stdout.log'),child.stdout??'');
        writeFileSync(join(logs,mode+'-stderr.log'),child.stderr??'');
      }
      if(child.error||Boolean(child.status===0)!==expected)throw Error('native package fixture unexpected result: '+scenario+' status='+child.status+' '+child.stderr);
      if(expected&&!existsSync(join(evidence,'official-verifier.json')))throw Error('official fresh-payload verifier evidence missing');
      if(coordinator)verifyCoordinatorReport(JSON.parse(readFileSync(coordinatorReport,'utf8')));
      if(prepare)verifyPrepareReport(JSON.parse(readFileSync(prepareReport,'utf8')));
      results.push({scenario,status:'passed',expected:expected?'accepted':'rejected'});
    } finally {rmSync(root,{recursive:true,force:true});}
  }
  return {scope:prepare?'native-prepare':coordinator?'native-coordinator':races?'native-package-races':'native-signed-package',status:'passed',verifier:'minisign-verify=0.3.0',results};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args=process.argv.slice(2);
    if(args.length<1||args.length>2||args[1]&&!['--races','--coordinator','--prepare'].includes(args[1]))throw Error('expected native binary and optional --races, --coordinator or --prepare');
    console.log(JSON.stringify(runPackageFixtures(args[0],{races:args[1]==='--races',coordinator:args[1]==='--coordinator',prepare:args[1]==='--prepare'})));
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
