// CI-only producer for freshly compiled, disposable actual Leaf app versions.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,chmodSync,existsSync,rmSync} from 'node:fs';
import {resolve,join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('..',import.meta.url));
function run(command,args,timeout=1200000){
 const result=spawnSync(command,args,{cwd:repo,stdio:'inherit',timeout,env:{...process.env,COPYFILE_DISABLE:'1'}});
 if(result.error||result.status!==0)throw Error('preservation_build_failed:'+basename(command));
}
function output(command,args){
 const result=spawnSync(command,args,{cwd:repo,encoding:'utf8',timeout:30000});
 if(result.error||result.status!==0)throw Error('preservation_identity_failed');return result.stdout.trim();
}
export function buildInstalledPreservation(evidenceRoot){
 assert.equal(process.platform,'darwin','actual Mac runner required');
 assert.equal(process.env.GITHUB_ACTIONS,'true','full CI environment required');
 assert.ok(evidenceRoot,'explicit evidence root required');
 const files=['package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json'];
 const originals=new Map(files.map(name=>[name,readFileSync(join(repo,name))]));
 const current=JSON.parse(originals.get('src-tauri/tauri.conf.json')).version;
 const parsed=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/.exec(current);
 assert.ok(parsed&&Number(parsed[4])>1,'explicit preceding beta required');
 const previous=parsed.slice(1,4).join('.')+'-beta.'+(Number(parsed[4])-1);
 const root=mkdtempSync(join(tmpdir(),'leaf-update-build-'));chmodSync(root,0o700);
 // Keep all production freshness/handshake budgets: exercise optimized actual
 // Leaf executables instead of timing unoptimized debug validation of large apps.
 const apps=[];
 try{
  for(const [name,version]of [['old',previous],['new',current]]){
   for(const file of files){
    const bytes=originals.get(file);let text=bytes.toString();
    if(file==='package.json'||file==='package-lock.json'||file.endsWith('tauri.conf.json')){
     const data=JSON.parse(text);data.version=version;if(file==='package-lock.json')data.packages[''].version=version;text=JSON.stringify(data,null,2)+'\n';
    }else{
     const expression=file.endsWith('Cargo.lock')?/(\[\[package\]\]\nname = "leaf"\nversion = ")[^"]+("\n)/:/(\[package\]\nname = "leaf"\nversion = ")[^"]+("\n)/;
     assert.ok(expression.test(text),'exact Leaf package identity required');text=text.replace(expression,(_match,start,end)=>start+version+end);
    }
    writeFileSync(join(repo,file),text);
   }
   const built=join(repo,'src-tauri/target/release/bundle/macos/Leaf.app');
   if(existsSync(built))rmSync(built,{recursive:true,force:true});
   run(process.execPath,[join(repo,'scripts/desktop-build.mjs'),'--bundles','app','--features','native-smoke,tauri/custom-protocol','--config','src-tauri/tauri.macos.conf.json']);
   for(const role of ['leaf','leaf-mcp-adapter','leaf-update-helper']){
    const binary=join(built,'Contents/MacOS',role);
    const identity=output(binary,['--leaf-build-identity']).split(':');
    assert.equal(identity[0],version,'actual compiled version must match the bundle');
    assert.equal(identity[4],'native-smoke','isolated fixture hooks must be compiled');
    assert.equal(identity[5],'release','actual preservation requires the optimized production profile');
    run('/usr/bin/codesign',['--force','--sign','-',binary]);
   }
   run('/usr/bin/codesign',['--force','--sign','-',built]);
   run('/usr/bin/codesign',['--verify','--deep','--strict','--all-architectures',built]);
   const directory=join(root,name);mkdirSync(directory,{mode:0o700});const app=join(directory,'Leaf.app');
   run('/usr/bin/ditto',[built,app]);apps.push(app);
  }
  run(process.execPath,[join(repo,'tests/desktop-updates-installed.mjs'),'--platform','darwin','--old-app',apps[0],'--new-app',apps[1],'--evidence-root',resolve(evidenceRoot)],900000);
 }finally{
  for(const[file,bytes]of originals)writeFileSync(join(repo,file),bytes);
  rmSync(root,{recursive:true,force:true});
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);assert.equal(args.length,2);assert.equal(args[0],'--evidence-root');buildInstalledPreservation(args[1]);
}
