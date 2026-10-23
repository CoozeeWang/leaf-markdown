// TEST-ONLY Mac filesystem/helper protocol matrix. Never targets the daily app.
import {createHash} from 'node:crypto';
import {chmodSync,copyFileSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,readlinkSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {fixtureInit,signFixture} from '../scripts/desktop-update-signing-fixture.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function run(command,args,{env,timeout=120000}={}){
  const child=spawnSync(command,args,{encoding:'utf8',timeout,maxBuffer:4*1024*1024,env:env??process.env});
  if(child.error||child.status!==0)throw Error('Mac fixture command failed: '+basename(command)+' status='+child.status+' '+(child.stderr??''));
  return child.stdout;
}
function compileSynthetic(path,version,role,source){
  const c=path+'.c';
  writeFileSync(c,source,{flag:'wx',mode:0o600});
  run('/usr/bin/clang',['-Os','-DFIXTURE_VERSION='+JSON.stringify(version),'-DFIXTURE_ROLE='+JSON.stringify(role),c,'-o',path]);
  rmSync(c);chmodSync(path,0o700);
}
const syntheticSource=String.raw`#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <stdlib.h>
#ifndef FIXTURE_VERSION
#error explicit fixture version required
#endif
#ifndef FIXTURE_ROLE
#error explicit fixture role required
#endif
__attribute__((used)) static const char identity[]="LEAF_UPDATE_BINARY_IDENTITY_V1\0Leaf\0studio.leaf.editor\0" FIXTURE_VERSION "\0" FIXTURE_ROLE "\0";
int main(int argc,char **argv){
  if(identity[0]!='L')return 91;
  if(argc==2&&!strcmp(argv[1],"--hold")){puts("fixture-ready");fflush(stdout);for(;;)pause();}
  if(argc==5&&!strcmp(argv[1],"--leaf-update-reconcile")){
    char *path=strdup(argv[2]);if(!path)return 92;char *slash=strrchr(path,'/');if(!slash)return 93;slash[1]=0;
    char receipt[4096];if(snprintf(receipt,sizeof(receipt),"%srestart-receipt.json",path)>=(int)sizeof(receipt))return 94;
    int fd=open(receipt,O_WRONLY|O_CREAT|O_EXCL,0600);if(fd<0)return 95;
    const char json[]="{\"version\":\"" FIXTURE_VERSION "\",\"role\":\"" FIXTURE_ROLE "\",\"restart\":1}";
    if(write(fd,json,sizeof(json)-1)!=(ssize_t)(sizeof(json)-1)||fsync(fd))return 96;close(fd);free(path);
  }
  return 0;
}
`;
function app(root,version,{helper,adapter,source}={}){
  mkdirSync(join(root,'Contents/MacOS'),{recursive:true,mode:0o700});
  mkdirSync(join(root,'Contents/Resources'),{mode:0o700});
  writeFileSync(join(root,'Contents/Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>studio.leaf.editor</string><key>CFBundleShortVersionString</key><string>'+version+'</string><key>CFBundleVersion</key><string>'+version+'</string><key>CFBundleExecutable</key><string>leaf</string></dict></plist>',{mode:0o600});
  writeFileSync(join(root,'Contents/Resources/data.txt'),'Synthetic Mac complete bundle '+version,{mode:0o600});
  for(const role of ['leaf','leaf-mcp-adapter','leaf-update-helper']){
    const target=join(root,'Contents/MacOS',role),from=role==='leaf-update-helper'?helper:role==='leaf-mcp-adapter'?adapter:null;
    if(from){copyFileSync(from,target);chmodSync(target,0o700);}else compileSynthetic(target,version,role,source);
    run('/usr/bin/codesign',['--force','--sign','-',target]);
  }
  run('/usr/bin/codesign',['--force','--sign','-',root]);
  run('/usr/bin/codesign',['--verify','--deep','--strict','--all-architectures',root]);
}
function inventory(root,prefix='Leaf.app'){
  const entries=[];
  function walk(path,name){
    const stat=lstatSync(path);
    if(stat.isSymbolicLink())entries.push({path:name,kind:'symlink',size:0,sha256:null,target:readlinkSync(path),executable:false});
    else if(stat.isDirectory()){entries.push({path:name,kind:'directory',size:0,sha256:null,target:null,executable:false});for(const child of readdirSync(path).sort())walk(join(path,child),name+'/'+child);}
    else if(stat.isFile())entries.push({path:name,kind:'file',size:stat.size,sha256:hash(readFileSync(path)),target:null,executable:Boolean(stat.mode&0o111)});
    else throw Error('unexpected Mac fixture inventory entry');
  }
  walk(root,prefix);return entries;
}
export function runMacFixtures({binary,helper,adapter,evidenceRoot}){
  if(process.platform!=='darwin')throw Error('actual Mac host required; no simulated platform pass');
  binary=realpathSync(binary);helper=realpathSync(helper);adapter=realpathSync(adapter);
  const version=JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8')).version;
  const parsed=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/.exec(version);
  if(!parsed)throw Error('strict synthetic product version required');
  const[,major,minor,patch,beta]=parsed;
  const oldVersion=beta&&Number(beta)>1?major+'.'+minor+'.'+patch+'-beta.'+(Number(beta)-1)
    :Number(patch)>0?major+'.'+minor+'.'+(Number(patch)-1):null;
  if(!oldVersion)throw Error('explicit lower synthetic version required');
  if(run(helper,['--leaf-build-identity']).trim().split(':')[0]!==version)throw Error('actual helper version differs from fresh package');
  const root=realpathSync(mkdtempSync(join(tmpdir(),'leaf-update-test-')));chmodSync(root,0o700);
  const evidence=join(root,'evidence'),options={runRoot:root,evidenceRoot:evidence,version,platform:'darwin',arch:process.arch==='arm64'?'aarch64':process.arch};
  try{
    fixtureInit(options);
    const old=join(root,'Old.app'),staging=join(root,'payload');mkdirSync(staging,{mode:0o700});
    app(old,oldVersion,{source:syntheticSource});
    const prepared=join(staging,'Leaf.app');app(prepared,version,{helper,adapter,source:syntheticSource});
    const metadata={schema:1,product:'Leaf',identifier:'studio.leaf.editor',version,platform:'darwin',arch:options.arch,root:'Leaf.app',inventory:inventory(prepared)};
    writeFileSync(join(staging,'leaf-update.json'),JSON.stringify(metadata),{flag:'wx',mode:0o600});
    const payload=join(root,'Leaf-mac-synthetic.tar.gz');
    // These bounded fixture paths fit USTAR. Avoid host-specific PAX fields;
    // production extraction must continue rejecting unknown archive metadata.
    run('/usr/bin/tar',['-czf',payload,'--format=ustar','--no-xattrs','--no-acls','--no-fflags','-C',staging,'leaf-update.json','Leaf.app'],{env:{...process.env,COPYFILE_DISABLE:'1'}});chmodSync(payload,0o600);
    signFixture({...options,payloadFile:payload});
    const child=spawnSync(binary,['--mac-update-fixture'],{encoding:'utf8',env:{...process.env,LEAF_UPDATE_PACKAGE_TEST_ROOT:root},timeout:300000,maxBuffer:4*1024*1024});
    const reportPath=join(root,'mac-result.json');
    if(evidenceRoot){
      mkdirSync(evidenceRoot,{recursive:true});
      writeFileSync(join(evidenceRoot,'mac-stdout.log'),child.stdout??'');writeFileSync(join(evidenceRoot,'mac-stderr.log'),child.stderr??'');
      if(existsSync(reportPath))copyFileSync(reportPath,join(evidenceRoot,'mac-result.json'));
    }
    if(child.error||child.status!==0)throw Error('actual Mac helper matrix failed: status='+child.status+' '+(child.stderr??''));
    const report=JSON.parse(readFileSync(reportPath,'utf8'));verifyMacReport(report);
    if(!existsSync(join(evidence,'official-verifier.json')))throw Error('fresh package official verification missing');
    return report;
  }finally{rmSync(root,{recursive:true,force:true});}
}
export const macCases=Object.freeze(['helper_wait_gui_exit_success', 'before_exchange_failure', 'exchange_failure', 'post_check_atomic_rollback', 'swap_back_failure_recovery', 'invalid_commit_token', 'armed_eof_no_install', 'owned_leaf_occupancy', 'owned_adapter_occupancy', 'owned_helper_occupancy', 'same_name_unrelated_preserved', 'wrong_bundle_identifier', 'wrong_bundle_version', 'wrong_bundle_architecture', 'bad_platform_signature', 'missing_helper', 'missing_adapter', 'changed_resource_inventory', 'changed_external_helper', 'changed_target_anchor', 'replay_no_second_restart', 'occupancy_after_ready']);
export function verifyMacReport(report){
  if(report?.pass!==true||report.layer!=='actual-native-filesystem'||report.tracer!=='mac-atomic-helper'
    ||report.synthetic_app_bundle!==true||report.actual_leaf_gui!==false||report.installed_daily_app!==false
    ||!macCases.length||report.executed!==macCases.length||report.scenarios?.length!==macCases.length)throw Error('Mac native fixture incomplete');
  for(const[index,row]of report.scenarios.entries()){
    if(row.name!==macCases[index]||row.pass!==true)throw Error('Mac native fixture case failed');
    const d=row.details,success=['helper_wait_gui_exit_success','same_name_unrelated_preserved','replay_no_second_restart'].includes(row.name);
    const swaps=row.name==='post_check_atomic_rollback'?2:row.name==='swap_back_failure_recovery'||success?1:0;
    if(d?.exchanges!==swaps||d.restart_count!==(success?1:0)||d.profile_hashes_unchanged!==true||d.old_recovery_verified!==true)throw Error('Mac filesystem/restart proof failed: '+row.name);
    if(success&&d.state!=='installed')throw Error('Mac success state missing');
    if(row.name.startsWith('owned_')&&(d.actual_kernel_uuid_match_refused!==true||d.actual_kernel_cdhash_match_refused!==true))throw Error('Mac matching kernel UUID must fail closed');
    if(row.name==='same_name_unrelated_preserved'&&(d.actual_kernel_uuid_difference_proved!==true||d.actual_kernel_cdhash_difference_proved!==true||d.unrelated_process_untouched!==true))throw Error('Mac unrelated kernel UUID proof missing');
    if(row.name==='post_check_atomic_rollback'&&d.state!=='rolled_back')throw Error('Mac rollback state missing');
    if(row.name==='swap_back_failure_recovery'&&d.state!=='rollback_failed')throw Error('Mac failed rollback misreported');
  }
  return report;
}
if(import.meta.url===pathToFileURL(resolve(process.argv[1]??'.')).href){
  const args=process.argv.slice(2),value=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
  if(!args.includes('--fixture'))throw Error('--fixture required');
  const binary=value('--binary')??'src-tauri/target/debug/leaf',helper=value('--helper')??join(dirname(binary),'leaf-update-helper'),adapter=value('--adapter')??join(dirname(binary),'leaf-mcp-adapter');
  console.log(JSON.stringify(runMacFixtures({binary,helper,adapter,evidenceRoot:value('--evidence-root')})));
}
