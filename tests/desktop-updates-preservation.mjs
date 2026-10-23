// The caller collects real semantic values. This oracle proves comparison and
// redaction only; its output alone is never installed-app or human evidence.
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {readFile,mkdir,lstat,realpath,open,rename} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
const contract=JSON.parse(await readFile(new URL('./fixtures/desktop-updates/profile-manifest.json',import.meta.url),'utf8'));
const categories=Object.freeze([...contract.required_categories]);
const fail=code=>{throw Error('preservation_'+code);};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
function canonical(value,depth=0){
 if(depth>32)fail('invalid_value');
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(item=>canonical(item,depth+1)).join(',')+']';
 if(value&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key],depth+1)).join(',')+'}';
 fail('invalid_value');
}
function key(salt){if(typeof salt!=='string'||! /^[a-f0-9]{64}$/i.test(salt))fail('invalid_audit_key');return Buffer.from(salt,'hex');}
const digest=(salt,domain,value)=>createHmac('sha256',key(salt)).update(domain+'\0'+canonical(value)).digest('hex');
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
async function credentialProof(credential,probe){
 if(typeof credential!=='string'||credential.length<16||typeof probe!=='function')fail('credential_unusable');
 const challenge=randomBytes(32).toString('hex');let timer;
 try{
  const response=await Promise.race([Promise.resolve().then(()=>probe(challenge)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),5000);timer.unref?.();})]);
  const expected=createHmac('sha256',credential).update(challenge).digest('hex');
  if(response?.present!==true||typeof response.response!=='string'||!/^[a-f0-9]{64}$/i.test(response.response)||!timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(response.response,'hex')))fail('credential_unusable');
 }catch{fail('credential_unusable');}finally{clearTimeout(timer);}
}
async function persist(root,snapshot){
 try{
  await mkdir(root,{recursive:true,mode:0o700});if((await lstat(root)).isSymbolicLink())fail('evidence_root');
  const canonicalRoot=await realpath(root),run=join(canonicalRoot,snapshot.run_id);
  await mkdir(run,{recursive:true,mode:0o700});const info=await lstat(run);if(!info.isDirectory()||info.isSymbolicLink())fail('evidence_root');
  const target=join(run,snapshot.snapshot_id);await mkdir(target,{mode:0o700});
  const temporary=join(target,'snapshot.tmp'),file=await open(temporary,'wx',0o600);
  try{await file.writeFile(JSON.stringify(snapshot)+'\n');await file.sync();}finally{await file.close();}
  await rename(temporary,join(target,'snapshot.json'));
 }catch{fail('immutable_snapshot');}
}
export async function captureProfile({runId,snapshotId,phase,profile,salt,credential,probeCredential,evidenceRoot}){
 if(!id(runId)||!id(snapshotId)||!['before','success','rollback'].includes(phase))fail('invalid_identity');
 key(salt);
 if(!profile||typeof profile.version!=='string'||!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(profile.version)||profile.application?.identifier!==contract.app_identifier)fail('invalid_profile');
 if(Object.keys(profile).some(name=>!['version','history',...categories].includes(name)))fail('unexpected_migration');
 const values={};for(const name of categories){if(!Object.hasOwn(profile,name)||profile[name]===undefined||profile[name]===null)fail('missing_category');values[name]=digest(salt,'category:'+name,profile[name]);}
 if(canonical(profile).length>8*1024*1024||!Array.isArray(profile.history)||profile.history.length>1000)fail('invalid_history');
 await credentialProof(credential,probeCredential);
 const snapshot={schema_version:1,run_id:runId,snapshot_id:snapshotId,phase,version:profile.version,categories:values,
  history:profile.history.map(value=>digest(salt,'history',value)),credential:{present:true,usable:true,opaque_identity:digest(salt,'credential',credential)}};
 snapshot.integrity=digest(salt,'snapshot',snapshot);freeze(snapshot);
 if(evidenceRoot)await persist(evidenceRoot,snapshot);
 return snapshot;
}
function authenticated(snapshot,salt,runId){
 if(!snapshot||snapshot.schema_version!==1||snapshot.run_id!==runId||!id(snapshot.snapshot_id))fail('snapshot_identity');
 const {integrity,...body}=snapshot;if(integrity!==digest(salt,'snapshot',body))fail('snapshot_tampered');
 if(!snapshot.categories||Object.keys(snapshot.categories).sort().join(',')!==[...categories].sort().join(',')||!Array.isArray(snapshot.history))fail('snapshot_incomplete');
}
export function compareProfiles(before,after,{runId,salt,fromVersion,toVersion}){
 if(!id(runId))fail('invalid_identity');authenticated(before,salt,runId);authenticated(after,salt,runId);
 if(before.phase!=='before'||before.version!==fromVersion||!['success','rollback'].includes(after.phase)||after.version!==(after.phase==='success'?toVersion:fromVersion))fail('version_transition');
 const changed=categories.filter(name=>before.categories[name]!==after.categories[name]);
 if(before.credential.present!==true||after.credential.present!==true||before.credential.usable!==true||after.credential.usable!==true||before.credential.opaque_identity!==after.credential.opaque_identity)changed.push('credential');
 if(after.history.length<before.history.length||after.history.length>before.history.length+contract.normal_history_increment||before.history.some((item,index)=>after.history[index]!==item))changed.push('history');
 return freeze({pass:changed.length===0,changed,run_id:runId,before_snapshot:before.snapshot_id,after_snapshot:after.snapshot_id});
}
export async function readProfileFile(root,relative='profile.json'){
 let file;
 try{
  if(typeof relative!=='string'||isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(part=>!part||part==='.'||part==='..'))fail('profile_path');
  const base=resolve(root);if((await lstat(base)).isSymbolicLink())fail('profile_path');let target=base;
  for(const part of relative.split('/')){target=join(target,part);if((await lstat(target)).isSymbolicLink())fail('profile_path');}
  file=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);const metadata=await file.stat();if(!metadata.isFile()||metadata.size>8*1024*1024)fail('profile_file');
  return JSON.parse(await file.readFile('utf8'));
 }catch{fail('profile_file');}finally{await file?.close();}
}
