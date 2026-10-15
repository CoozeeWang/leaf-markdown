//! Direct native-host installation; fixed destinations, no documents or secrets in exports.
use std::{path::{Path,PathBuf},collections::HashSet};
use serde_json::{Value,json};
use super::mcp::ai_credentials::{private_directory,write_private_existing_parent};

fn crc32(bytes:&[u8])->u32 {let mut crc=!0u32;for &byte in bytes{crc^=byte as u32;for _ in 0..8{crc=(crc>>1)^if crc&1!=0{0xedb88320}else{0};}}!crc}
fn zip_stored(entries:&[(&str,Vec<u8>)])->Vec<u8>{
 let mut out=Vec::new();let mut central=Vec::new();
 fn u16le(out:&mut Vec<u8>,v:u16){out.extend(v.to_le_bytes());}fn u32le(out:&mut Vec<u8>,v:u32){out.extend(v.to_le_bytes());}
 for (name,data) in entries{let offset=out.len() as u32;let crc=crc32(data);let size=data.len() as u32;let n=name.as_bytes();
  u32le(&mut out,0x04034b50);for v in [20,0,0,0,0]{u16le(&mut out,v);}for v in [crc,size,size]{u32le(&mut out,v);}u16le(&mut out,n.len() as u16);u16le(&mut out,0);out.extend(n);out.extend(data);
  u32le(&mut central,0x02014b50);for v in [20,20,0,0,0,0]{u16le(&mut central,v);}for v in [crc,size,size]{u32le(&mut central,v);}for v in [n.len() as u16,0,0,0,0]{u16le(&mut central,v);}u32le(&mut central,0);u32le(&mut central,offset);central.extend(n);
 }
 let start=out.len() as u32;let size=central.len() as u32;out.extend(central);u32le(&mut out,0x06054b50);for v in [0,0,entries.len() as u16,entries.len() as u16]{u16le(&mut out,v);}u32le(&mut out,size);u32le(&mut out,start);u16le(&mut out,0);out
}
pub fn claude_bundle(directory:&Path,command:&Value)->Result<PathBuf,String>{
 private_directory(directory)?;
 let manifest=json!({"manifest_version":"0.3","name":"leaf-mcp","display_name":"Leaf","version":env!("CARGO_PKG_VERSION"),"description":"Read and edit open Leaf documents while MCP is enabled.","author":{"name":"Leaf contributors"},"compatibility":{"platforms":[std::env::consts::OS.replace("macos","darwin").replace("windows","win32")]},"server":{"type":"node","entry_point":"server/index.js","mcp_config":{"command":"node","args":["${__dirname}/server/index.js"]}}});
 let script=format!("const c={};\n{}",serde_json::to_string(command).map_err(|_|"install_encoding")?,include_str!("claude_stdio.cjs"));
 let bytes=zip_stored(&[("manifest.json",serde_json::to_vec(&manifest).unwrap()),("server/index.js",script.into_bytes())]);
 let path=directory.join("Leaf.mcpb");
 // A private export includes local executable paths, never a bearer or API key.
 let mut temp=tempfile::NamedTempFile::new_in(directory).map_err(|_|"install_write")?;use std::io::Write;
 temp.write_all(&bytes).and_then(|_|temp.as_file().sync_all()).map_err(|_|"install_write")?;temp.persist(&path).map_err(|_|"install_write")?;Ok(path)
}
// serde_json normally accepts duplicate keys. Refuse them before merging host data.
struct UniqueValue(Value);
impl<'de> serde::Deserialize<'de> for UniqueValue {
 fn deserialize<D:serde::Deserializer<'de>>(d:D)->Result<Self,D::Error>{
  struct V;
  impl<'de> serde::de::Visitor<'de> for V{type Value=Value;fn expecting(&self,f:&mut std::fmt::Formatter)->std::fmt::Result{write!(f,"JSON without duplicate keys")}
   fn visit_map<M:serde::de::MapAccess<'de>>(self,mut map:M)->Result<Value,M::Error>{let mut object=serde_json::Map::new();let mut seen=HashSet::new();while let Some(k)=map.next_key::<String>()?{if !seen.insert(k.clone()){return Err(serde::de::Error::custom("duplicate configuration key"));}let v=map.next_value::<UniqueValue>()?;object.insert(k,v.0);}Ok(Value::Object(object))}
   fn visit_seq<A:serde::de::SeqAccess<'de>>(self,mut a:A)->Result<Value,A::Error>{let mut v=Vec::new();while let Some(x)=a.next_element::<UniqueValue>()?{v.push(x.0);}Ok(Value::Array(v))}
   fn visit_bool<E:serde::de::Error>(self,v:bool)->Result<Value,E>{Ok(json!(v))}fn visit_i64<E:serde::de::Error>(self,v:i64)->Result<Value,E>{Ok(json!(v))}fn visit_u64<E:serde::de::Error>(self,v:u64)->Result<Value,E>{Ok(json!(v))}fn visit_f64<E:serde::de::Error>(self,v:f64)->Result<Value,E>{Ok(json!(v))}fn visit_str<E:serde::de::Error>(self,v:&str)->Result<Value,E>{Ok(json!(v))}fn visit_string<E:serde::de::Error>(self,v:String)->Result<Value,E>{Ok(json!(v))}fn visit_unit<E:serde::de::Error>(self)->Result<Value,E>{Ok(Value::Null)}
  }d.deserialize_any(V).map(UniqueValue)
 }
}
pub fn install_workbuddy(target:&Path,command:&Value)->Result<(),String>{
 let parent=target.parent().ok_or("install_path")?;
 match std::fs::symlink_metadata(parent){Ok(m)if m.is_dir()&&!m.file_type().is_symlink()=>{},Ok(_)=>return Err("invalid_host_configuration".into()),Err(e)if e.kind()==std::io::ErrorKind::NotFound=>private_directory(parent)?,Err(_)=>return Err("host_configuration_unavailable".into())}
 if std::fs::symlink_metadata(target).is_ok_and(|m|!m.is_file()||m.file_type().is_symlink()||m.len()>1024*1024){return Err("invalid_host_configuration".into());}
 let lock=parent.join(".leaf-install.lock");let _lock=std::fs::OpenOptions::new().write(true).create_new(true).open(&lock).map_err(|_|"host_configuration_busy")?;
 struct Lock(PathBuf);impl Drop for Lock{fn drop(&mut self){let _=std::fs::remove_file(&self.0);}}let _cleanup=Lock(lock);
 let raw=match std::fs::read(target){Ok(v)=>Some(v),Err(e)if e.kind()==std::io::ErrorKind::NotFound=>None,Err(_)=>return Err("host_configuration_unavailable".into())};
 let mut value=if let Some(bytes)=&raw{serde_json::from_slice::<UniqueValue>(bytes).map_err(|_|"invalid_host_configuration")?.0}else{json!({})};
 let root=value.as_object_mut().ok_or("invalid_host_configuration")?;
 let servers=root.entry("mcpServers").or_insert(json!({})).as_object_mut().ok_or("invalid_host_configuration")?;
 let mut entry=command.clone();entry["type"]=json!("stdio");if servers.get("Leaf")==Some(&entry){return Ok(());}servers.insert("Leaf".into(),entry);
 let payload=serde_json::to_string_pretty(&value).map_err(|_|"install_encoding")?;
 if std::fs::symlink_metadata(target).is_ok_and(|m|m.file_type().is_symlink())||std::fs::read(target).ok()!=raw{return Err("host_configuration_changed".into());}
 if let Some(bytes)=&raw{let backup=parent.join(format!("mcp.json.leaf-backup-{}",super::mcp::ai_credentials::random_token()?));write_private_existing_parent(&backup,std::str::from_utf8(bytes).map_err(|_|"invalid_host_configuration")?)?;}
 write_private_existing_parent(target,&payload)
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn host_merge_preserves_other_entries_and_exact_backup(){let dir=tempfile::tempdir().unwrap();let target=dir.path().join("mcp.json");let original="{\n  \"setting\": true, \"mcpServers\": {\"Other\": {\"command\":\"synthetic\"}}\n}";std::fs::write(&target,original).unwrap();install_workbuddy(&target,&json!({"command":"synthetic-helper","args":["--descriptor","synthetic.json"]})).unwrap();let v:Value=serde_json::from_slice(&std::fs::read(&target).unwrap()).unwrap();assert_eq!(v["mcpServers"]["Other"]["command"],"synthetic");assert_eq!(v["setting"],true);let backups:Vec<_>=std::fs::read_dir(dir.path()).unwrap().flatten().filter(|e|e.file_name().to_string_lossy().starts_with("mcp.json.leaf-backup-")).collect();assert_eq!(backups.len(),1);assert_eq!(std::fs::read(backups[0].path()).unwrap(),original.as_bytes());}
 #[test]fn invalid_and_duplicate_host_config_is_unchanged(){let dir=tempfile::tempdir().unwrap();let target=dir.path().join("mcp.json");for text in ["{broken","{\"mcpServers\":[],\"mcpServers\":{}}","[]"]{std::fs::write(&target,text).unwrap();assert!(install_workbuddy(&target,&json!({"command":"synthetic"})).is_err());assert_eq!(std::fs::read_to_string(&target).unwrap(),text);}}
 #[test]fn extension_zip_has_valid_headers_and_crc(){let dir=tempfile::tempdir().unwrap();let p=claude_bundle(dir.path(),&json!({"command":"synthetic-helper","args":["synthetic.json"]})).unwrap();let b=std::fs::read(p).unwrap();assert_eq!(&b[..4],b"PK\x03\x04");assert!(b.windows(13).any(|w|w==b"manifest.json"));assert_eq!(crc32(b"123456789"),0xcbf43926);}
 #[cfg(unix)]#[test]fn host_install_rejects_symlinks_and_preserves_directory_permissions(){
  use std::os::unix::{fs::{symlink,PermissionsExt}};
  let dir=tempfile::tempdir().unwrap();let host=dir.path().join("host");std::fs::create_dir(&host).unwrap();std::fs::set_permissions(&host,std::fs::Permissions::from_mode(0o755)).unwrap();
  let real=dir.path().join("real.json");std::fs::write(&real,"{}").unwrap();let target=host.join("mcp.json");symlink(&real,&target).unwrap();assert!(install_workbuddy(&target,&json!({"command":"synthetic"})).is_err());assert_eq!(std::fs::read_to_string(&real).unwrap(),"{}");std::fs::remove_file(&target).unwrap();
  install_workbuddy(&target,&json!({"command":"synthetic"})).unwrap();assert_eq!(std::fs::metadata(&host).unwrap().permissions().mode()&0o777,0o755);assert_eq!(std::fs::metadata(&target).unwrap().permissions().mode()&0o777,0o600);
  let link=dir.path().join("linked-host");symlink(&host,&link).unwrap();assert!(install_workbuddy(&link.join("mcp.json"),&json!({"command":"synthetic"})).is_err());
 }
 #[cfg(target_os="macos")]#[test]fn extension_is_readable_by_system_zip_tools(){
  let dir=tempfile::tempdir().unwrap();let p=claude_bundle(dir.path(),&json!({"command":"synthetic-helper","args":["--descriptor","synthetic.json"]})).unwrap();
  let check=std::process::Command::new("/usr/bin/unzip").arg("-t").arg(&p).output().unwrap();assert!(check.status.success());
  let manifest=std::process::Command::new("/usr/bin/unzip").arg("-p").arg(&p).arg("manifest.json").output().unwrap();let v:Value=serde_json::from_slice(&manifest.stdout).unwrap();assert_eq!(v["server"]["type"],"node");assert!(v.get("user_config").is_none());
  let script=std::process::Command::new("/usr/bin/unzip").arg("-p").arg(&p).arg("server/index.js").output().unwrap();let script=String::from_utf8(script.stdout).unwrap();assert!(script.contains("synthetic-helper"));assert!(script.contains("synthetic.json"));assert!(!script.contains("api-key"));
  let launcher=dir.path().join("launcher.cjs");std::fs::write(&launcher,script.split_once(";\n").unwrap().1).unwrap();
  let harness=Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/claude-stdio-host.cjs");
  let result=std::process::Command::new("node").arg(harness).arg(launcher).output().unwrap();assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));

 }

}
