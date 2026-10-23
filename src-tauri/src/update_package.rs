//! Authenticated, bounded private update staging. Verified handles never cross IPC.
use std::{collections::{HashMap,HashSet},fs::{self,File,OpenOptions},io::{Read,Write},path::{Path,PathBuf},sync::Arc};
use base64::Engine;
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};
use crate::update_releases::CandidateIdentity;
pub const MAX_DOWNLOAD:u64=512*1024*1024;
pub const MAX_EXPANDED:u64=2*1024*1024*1024;
pub const MAX_ENTRIES:usize=20_000;
pub const MAX_DEPTH:usize=32;
pub const MAX_PATH:usize=4096;
const MAX_METADATA:u64=8*1024*1024;
const INVALID:&str="update_package_invalid";
const BLOCKED:&str="63f8a5f81fa7f5bce2e1ba0f18f6de3b27361e3f877ff1e1c796a1c3369407f7";
#[cfg_attr(feature="native-smoke",track_caller)]
fn error()->String {
    #[cfg(feature="native-smoke")] {
        static COUNT:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);
        if COUNT.fetch_add(1,std::sync::atomic::Ordering::Relaxed)<32 {
            eprintln!("update_package_diagnostic_line={}",std::panic::Location::caller().line());
        }
    }
    INVALID.into()
}
fn digest(bytes:&[u8])->String {format!("{:x}",Sha256::digest(bytes))}
fn bounded_size(current:u64,add:u64,max:u64)->Result<u64,String> {current.checked_add(add).filter(|n|*n<=max).ok_or_else(error)}
#[derive(Clone,Debug,Default)]
pub enum Trust {
    #[default] Pending,
    Rejected,
    Production{public_key:String,fingerprint:String},
    #[cfg(any(test,feature="native-smoke"))]
    Fixture{public_key:String,binding:FixtureBinding,run_root:PathBuf},
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct TrustConfig {schema:u8,status:String,owner:String,pubkey:serde_json::Value,provenance:serde_json::Value}
impl Trust {
    pub fn from_config(value:serde_json::Value)->Result<Self,String> {
        let config:TrustConfig=serde_json::from_value(value).map_err(|_|"update_identity_invalid")?;
        if config.schema!=1||config.owner!="Leaf release custodian" {return Err("update_identity_invalid".into());}
        if config.status=="pending_external_identity" && config.pubkey.is_null() && config.provenance.is_null() {return Ok(Self::Pending);}
        if config.status!="ready" {return Err("update_identity_invalid".into());}
        let key=config.pubkey.as_str().ok_or("update_identity_invalid")?;
        let (_,fingerprint,fixture)=decode_public(key)?;
        let provenance=&config.provenance;
        if fixture || fingerprint==BLOCKED || [
            ("product","Leaf"),("purpose","updater-signing"),("mode","production"),
            ("owner","Leaf release custodian"),("source","secure-local-custodian")
        ].iter().any(|(field,value)|provenance[*field].as_str()!=Some(*value))
            || provenance["schema"]!=1 || provenance["independent"]!=true || provenance["fingerprint"].as_str()!=Some(fingerprint.as_str()) {
                return Err("update_identity_invalid".into());
            }
        Ok(Self::Production{public_key:key.into(),fingerprint})
    }
    pub fn readiness_error(&self)->Option<&'static str> {
        match self {Self::Pending=>Some("update_signing_identity_pending"),Self::Rejected=>Some("update_identity_invalid"),_=>None}
    }
    fn key(&self)->Result<&str,String> {match self {Self::Pending=>Err("update_signing_identity_pending".into()),Self::Rejected=>Err("update_identity_invalid".into()),Self::Production{public_key,..}=>Ok(public_key),
        #[cfg(any(test,feature="native-smoke"))] Self::Fixture{public_key,..}=>Ok(public_key)}}
}
fn decode_text(text:&str,max:usize)->Result<String,String> {
    if text.is_empty()||text.len()>max||text.trim()!=text {return Err(error());}
    let bytes=base64::engine::general_purpose::STANDARD.decode(text).map_err(|_|error())?;
    if bytes.contains(&0) {return Err(error());}
    String::from_utf8(bytes).map_err(|_|error())
}
fn decode_public(encoded:&str)->Result<(minisign_verify::PublicKey,String,bool),String> {
    let text=decode_text(encoded,8192)?;
    let lines:Vec<_>=text.lines().collect();
    if lines.len()!=2||!lines[0].starts_with("untrusted comment: ") {return Err(error());}
    let raw=base64::engine::general_purpose::STANDARD.decode(lines[1]).map_err(|_|error())?;
    if raw.len()!=42||&raw[..2]!=b"Ed" {return Err(error());}
    let fingerprint=digest(&raw[10..]);
    if fingerprint==BLOCKED {return Err("update_identity_invalid".into());}
    let comment=lines[0].to_ascii_lowercase();
    let fixture=&raw[2..10]==b"TESTONLY"||comment.contains("test-only")||comment.contains("ripple");
    Ok((minisign_verify::PublicKey::decode(&text).map_err(|_|error())?,fingerprint,fixture))
}
fn signed_fields(comment:&str)->Result<HashMap<&str,&str>,String> {
    let mut fields=HashMap::new();
    if comment.len()>8192 {return Err(error());}
    for part in comment.split('\t') {
        let (key,value)=part.split_once(':').ok_or_else(error)?;
        if key.is_empty()||value.is_empty()||fields.insert(key,value).is_some() {return Err(error());}
    }
    Ok(fields)
}
#[cfg(any(test,feature="native-smoke"))]
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct FixtureBinding {
    pub mode:String,pub run_id:String,pub fingerprint:String,pub version:String,
    pub platform:String,pub arch:String,pub sha256:String,pub size:u64,pub file:String,
}
pub fn authenticate_file(path:&Path,candidate:&CandidateIdentity,trust:&Trust,current:&dyn Fn()->bool)->Result<String,String> {
    let (key,fingerprint,is_fixture)=decode_public(trust.key()?)?;
    let signature_text=decode_text(&candidate.signature,16384)?;
    if signature_text.lines().count()!=4 {return Err("update_signature_invalid".into());}
    let signature=minisign_verify::Signature::decode(&signature_text).map_err(|_|"update_signature_invalid")?;
    // The official dependency verifies both payload and trusted comment. ED-only streaming disallows legacy signatures.
    let mut verifier=key.verify_stream(&signature).map_err(|_|"update_signature_invalid")?;
    let entry=fs::symlink_metadata(path).map_err(|_|error())?;
    if !entry.is_file()||entry.file_type().is_symlink() {return Err(error());}
    #[cfg(unix)] {use std::os::unix::fs::MetadataExt;if entry.nlink()!=1 {return Err(error());}}
    let mut file=File::open(path).map_err(|_|error())?;
    let metadata=file.metadata().map_err(|_|error())?;
    if !metadata.is_file()||metadata.len()==0||metadata.len()>MAX_DOWNLOAD {return Err(error());}
    let mut hash=Sha256::new();let mut total=0u64;let mut buffer=[0u8;65536];
    loop {
        if !current() {return Err("update_cancelled".into());}
        let read=file.read(&mut buffer).map_err(|_|error())?;
        if read==0 {break;}
        total=bounded_size(total,read as u64,MAX_DOWNLOAD)?;
        hash.update(&buffer[..read]);verifier.update(&buffer[..read]);
    }
    verifier.finalize().map_err(|_|"update_signature_invalid")?;
    let sha256=format!("{:x}",hash.finalize());
    let fields=signed_fields(signature.trusted_comment())?;
    let os=candidate.platform.rsplit_once('-').ok_or_else(error)?.0;
    for (field,expected) in [("version",candidate.version.as_str()),("platform",os),("arch",candidate.arch.as_str()),("sha256",sha256.as_str())] {
        if fields.get(field).copied()!=Some(expected) {return Err("update_version_mismatch".into());}
    }
    if crate::update_releases::product_version(&candidate.tag).map(|v|v.to_string()).as_deref()!=Some(candidate.version.as_str()) {return Err("update_version_mismatch".into());}
    match trust {
        Trust::Pending=>return Err("update_signing_identity_pending".into()),
        Trust::Rejected=>return Err("update_identity_invalid".into()),
        Trust::Production{fingerprint:expected,..}=>{
            if is_fixture||&fingerprint!=expected||fingerprint==BLOCKED||fields.get("mode").copied()!=Some("production") {return Err("update_identity_invalid".into());}
        }
        #[cfg(any(test,feature="native-smoke"))]
        Trust::Fixture{binding,run_root,..}=>{
            let canonical=path.canonicalize().map_err(|_|error())?;
            let binding_hash=digest(&serde_json::to_vec(binding).map_err(|_|error())?);
            if !is_fixture||fingerprint!=binding.fingerprint||binding.mode!="TEST-ONLY-THROWAWAY"
                || fields.get("mode").copied()!=Some(binding.mode.as_str())
                || fields.get("run").copied()!=Some(binding.run_id.as_str())
                || fields.get("binding").copied()!=Some(binding_hash.as_str())
                || fields.get("file").copied()!=Some(binding.file.as_str())
                || binding.version!=candidate.version||binding.platform!=os||binding.arch!=candidate.arch
                || binding.sha256!=sha256||binding.size!=total
                || !canonical.starts_with(run_root)||binding.file.contains('/')||binding.file.contains('\\') {return Err("update_fixture_binding_invalid".into());}
        }
    }
    if !current() {return Err("update_cancelled".into());}
    Ok(sha256)
}
#[derive(Clone,Debug,Deserialize,Serialize,PartialEq,Eq)]
#[serde(deny_unknown_fields)]
pub struct InventoryEntry {
    pub path:String,pub kind:String,pub size:u64,
    #[serde(default)] pub sha256:Option<String>,
    #[serde(default)] pub target:Option<String>,
    #[serde(default)] pub executable:bool,
}
#[derive(Clone,Debug,Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
pub struct PackageMetadata {
    pub schema:u8,pub product:String,pub identifier:String,pub version:String,
    pub platform:String,pub arch:String,pub root:String,pub inventory:Vec<InventoryEntry>,
}
pub struct VerifiedPackage {
    id:[u8;16], app_instance:[u8;16], candidate:CandidateIdentity, sha256:String,
    private_root:tempfile::TempDir, metadata:PackageMetadata, trust:Trust, consumed:std::sync::atomic::AtomicBool,
}
impl VerifiedPackage {
    pub fn consumed(&self)->bool {self.consumed.load(std::sync::atomic::Ordering::Acquire)}
    pub fn consume(&self,app_instance:[u8;16],candidate:&str)->Result<(),String> {
        if !self.belongs_to(app_instance,candidate) {return Err("update_stale_package".into());}
        self.consumed.compare_exchange(false,true,std::sync::atomic::Ordering::AcqRel,std::sync::atomic::Ordering::Acquire)
            .map(|_|()).map_err(|_|"update_package_consumed".into())
    }
    pub fn candidate(&self)->&CandidateIdentity {&self.candidate}
    pub fn digest(&self)->&str {&self.sha256}
    pub fn staged_root(&self)->PathBuf {self.private_root.path().join("stage").join(&self.metadata.root)}
    /// Immutable inventory authenticated by the package verifier; native installer only.
    pub(crate) fn authenticated_metadata(&self)->&PackageMetadata {&self.metadata}
    pub fn handle_id(&self)->[u8;16] {self.id}
    pub fn belongs_to(&self,app_instance:[u8;16],candidate:&str)->bool {self.app_instance==app_instance&&self.candidate.opaque_id()==candidate}
    pub fn revalidate(&self,current:&dyn Fn()->bool)->Result<(),String> {
        if self.consumed() {return Err("update_package_consumed".into());}
        if authenticate_file(&self.private_root.path().join("verified.tar.gz"),&self.candidate,&self.trust,current)?!=self.sha256 {return Err(error());}
        validate_staged(&self.private_root.path().join("stage"),&self.metadata,&self.candidate,current)?;
        if self.consumed() {return Err("update_package_consumed".into());}Ok(())
    }
}
fn private_directory(path:&Path)->Result<(),String> {
    if !path.exists() {fs::create_dir_all(path).map_err(|_|error())?;}
    let metadata=fs::symlink_metadata(path).map_err(|_|error())?;
    if !metadata.is_dir()||metadata.file_type().is_symlink() {return Err(error());}
    #[cfg(unix)] {
        use std::os::unix::fs::{MetadataExt,PermissionsExt};
        let probe=tempfile::tempfile().map_err(|_|error())?.metadata().map_err(|_|error())?;
        if metadata.uid()!=probe.uid() {return Err(error());}
        fs::set_permissions(path,fs::Permissions::from_mode(0o700)).map_err(|_|error())?;
        if fs::metadata(path).map_err(|_|error())?.mode()&0o077!=0 {return Err(error());}
    }
    #[cfg(windows)] crate::mcp::ai_credentials::private_directory(path).map_err(|_|error())?;
    Ok(())
}
fn private_file(path:&Path)->Result<File,String> {
    let mut options=OpenOptions::new();options.write(true).create_new(true);
    #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}
    options.open(path).map_err(|_|error())
}
pub async fn download(candidate:CandidateIdentity,trust:Trust,cache:&Path,app_instance:[u8;16],source:Option<&str>,
    current:Arc<dyn Fn()->bool+Send+Sync>,progress:Arc<dyn Fn(u64,Option<u64>)+Send+Sync>,verifying:Arc<dyn Fn()+Send+Sync>)->Result<Arc<VerifiedPackage>,String> {
    trust.key()?;
    private_directory(cache)?;
    let temporary=tempfile::Builder::new().prefix("operation-").tempdir_in(cache).map_err(|_|error())?;
    let mut file=private_file(&temporary.path().join("partial"))?;
    let testing=source.is_some_and(crate::update_releases::fixture_source);
    if source.is_some()&&!testing {return Err("update_source_rejected".into());}
    let url=if let Some(source)=source {format!("{source}/package/{}",candidate.asset_id)} else {
        if !crate::update_releases::official_asset(&candidate.url,&candidate.tag) {return Err("update_asset_rejected".into());}candidate.url.clone()
    };
    let client=crate::update_releases::client(testing)?;
    let mut response=client.get(url).timeout(std::time::Duration::from_secs(15*60)).send().await.map_err(crate::update_releases::network_error)?;
    if !response.status().is_success() {return Err("update_download_failed".into());}
    let length=response.content_length();
    if length.is_some_and(|n|n>MAX_DOWNLOAD) {return Err("update_response_too_large".into());}
    let mut received=0;let mut reported=0;
    while let Some(chunk)=response.chunk().await.map_err(crate::update_releases::network_error)? {
        if !current() {return Err("update_cancelled".into());}
        received=bounded_size(received,chunk.len() as u64,MAX_DOWNLOAD)?;
        file.write_all(&chunk).map_err(|_|error())?;
        if reported==0||received-reported>=65536 {progress(received,length);reported=received;}
    }
    if received==0||length.is_some_and(|n|n!=received)||!current() {return Err(error());}
    progress(received,length);file.sync_all().map_err(|_|error())?;drop(file);verifying();
    tokio::task::spawn_blocking(move|| {
        let sha256=authenticate_file(&temporary.path().join("partial"),&candidate,&trust,current.as_ref())?;
        let stage=temporary.path().join("stage");fs::create_dir(&stage).map_err(|_|error())?;
        let metadata=extract(&temporary.path().join("partial"),&stage,&candidate,&sha256,current.as_ref())?;
        validate_staged(&stage,&metadata,&candidate,current.as_ref())?;
        if !current() {return Err("update_cancelled".into());}
        fs::rename(temporary.path().join("partial"),temporary.path().join("verified.tar.gz")).map_err(|_|error())?;
        #[cfg(unix)] File::open(temporary.path()).and_then(|f|f.sync_all()).map_err(|_|error())?;
        let mut id=[0u8;16];getrandom::fill(&mut id).map_err(|_|error())?;
        Ok(Arc::new(VerifiedPackage{id,app_instance,candidate,sha256,private_root:temporary,metadata,trust,consumed:std::sync::atomic::AtomicBool::new(false)}))
    }).await.map_err(|_|error())?
}

fn safe_path(value:&str)->Result<Vec<&str>,String> {
    if value.is_empty()||value.len()>MAX_PATH||value.starts_with('/')||value.contains(['\\',':','\0'])
        || value.bytes().any(|b|b<32||b==127) {return Err(error());}
    let parts:Vec<_>=value.split('/').collect();
    if parts.len()>MAX_DEPTH||parts.iter().any(|part| {
        if part.is_empty()||matches!(*part,"."|"..")||part.ends_with(['.',' ']) {return true;}
        let base=part.split('.').next().unwrap_or("").to_ascii_uppercase();
        matches!(base.as_str(),"CON"|"PRN"|"AUX"|"NUL") || (base.len()==4&&(base.starts_with("COM")||base.starts_with("LPT"))&&matches!(base.as_bytes()[3],b'1'..=b'9'))
    }) {return Err(error());}
    Ok(parts)
}
fn normalized_link(path:&str,target:&str,root:&str)->Result<String,String> {
    if target.is_empty()||target.len()>MAX_PATH||target.starts_with('/')||target.contains(['\\',':','\0']) {return Err(error());}
    let mut result:Vec<_>=path.split('/').collect();result.pop();
    for part in target.split('/') {
        match part {""|"."=>{}, ".."=>{if result.len()<=1 {return Err(error());}result.pop();}, _=>result.push(part)}
        if result.len()>MAX_DEPTH {return Err(error());}
    }
    let resolved=result.join("/");
    if result.first().copied()!=Some(root) {return Err(error());}
    safe_path(&resolved)?;Ok(resolved)
}
fn validate_links(entries:&HashMap<String,InventoryEntry>,root:&str)->Result<(),String> {
    let mut directory_links=Vec::new();
    for entry in entries.values().filter(|entry|entry.kind=="symlink") {
        let mut resolved=normalized_link(&entry.path,entry.target.as_deref().ok_or_else(error)?,root)?;
        let mut visited=HashSet::new();visited.insert(entry.path.clone());
        for _ in 0..MAX_DEPTH {
            let mut substitution=None;
            let parts:Vec<_>=resolved.split('/').collect();
            for count in 1..=parts.len() {
                let prefix=parts[..count].join("/");
                if let Some(link)=entries.get(&prefix).filter(|e|e.kind=="symlink") {
                    if !visited.insert(prefix.clone()) {return Err(error());}
                    let mut next=normalized_link(&prefix,link.target.as_deref().ok_or_else(error)?,root)?;
                    if count<parts.len() {next.push('/');next.push_str(&parts[count..].join("/"));}
                    safe_path(&next)?;substitution=Some(next);break;
                }
            }
            if let Some(next)=substitution {resolved=next;} else {
                let target=entries.get(&resolved).ok_or_else(error)?;
                if target.kind=="directory" {
                    let parent=entry.path.rsplit_once('/').ok_or_else(error)?.0.to_owned();
                    directory_links.push((parent,resolved.clone()));
                }
                resolved.clear();break;
            }
        }
        if !resolved.is_empty() {return Err(error());}
    }
    // No archive member may be written through an earlier symbolic link.
    for entry in entries.values() {
        let parts=safe_path(&entry.path)?;
        for count in 1..parts.len() {
            if entries.get(&parts[..count].join("/")).is_none_or(|parent|parent.kind!="directory") {return Err(error());}
        }
    }
    // Directory containment plus resolved directory links must remain acyclic.
    // Kahn's algorithm bounds work to the inventory without recursive traversal.
    let mut graph:HashMap<String,Vec<String>>=entries.values().filter(|entry|entry.kind=="directory")
        .map(|entry|(entry.path.clone(),Vec::new())).collect();
    for entry in entries.values().filter(|entry|entry.kind=="directory"&&entry.path!=root) {
        let parent=entry.path.rsplit_once('/').ok_or_else(error)?.0;
        graph.get_mut(parent).ok_or_else(error)?.push(entry.path.clone());
    }
    for (parent,target) in directory_links {graph.get_mut(&parent).ok_or_else(error)?.push(target);}
    let mut degree:HashMap<String,usize>=graph.keys().map(|name|(name.clone(),0)).collect();
    for children in graph.values() {for child in children {*degree.get_mut(child).ok_or_else(error)?+=1;}}
    let mut ready:Vec<String>=degree.iter().filter(|(_,value)|**value==0).map(|(name,_)|name.clone()).collect();
    let mut visited=0;
    while let Some(name)=ready.pop() {
        visited+=1;
        for child in graph.get(&name).ok_or_else(error)? {
            let value=degree.get_mut(child).ok_or_else(error)?;*value-=1;
            if *value==0 {ready.push(child.clone());}
        }
    }
    if visited!=graph.len() {return Err(error());}
    Ok(())
}
struct HashingReader<R> {inner:R,hash:Sha256,read:u64}
impl<R:Read> Read for HashingReader<R> {
    fn read(&mut self,bytes:&mut [u8])->std::io::Result<usize> {
        let read=self.inner.read(bytes)?;
        self.read=self.read.checked_add(read as u64).filter(|n|*n<=MAX_DOWNLOAD).ok_or_else(||std::io::Error::other("download limit"))?;
        self.hash.update(&bytes[..read]);Ok(read)
    }
}
struct LimitedReader<R> {inner:R,read:u64}
impl<R:Read> Read for LimitedReader<R> {
    fn read(&mut self,bytes:&mut [u8])->std::io::Result<usize> {
        let read=self.inner.read(bytes)?;
        self.read=self.read.checked_add(read as u64).filter(|size|*size<=MAX_EXPANDED+MAX_ENTRIES as u64*2048)
            .ok_or_else(||std::io::Error::other("archive limit"))?;
        Ok(read)
    }
}
fn pax(bytes:&[u8],path:&mut Option<String>,link:&mut Option<String>)->Result<(),String> {
    if bytes.len()>8192 {return Err(error());}
    let mut offset=0;let mut seen=HashSet::new();
    while offset<bytes.len() {
        let space=bytes[offset..].iter().position(|b|*b==b' ').ok_or_else(error)?+offset;
        let length=std::str::from_utf8(&bytes[offset..space]).map_err(|_|error())?.parse::<usize>().map_err(|_|error())?;
        let end=offset.checked_add(length).filter(|end|*end<=bytes.len()&&*end>space+1).ok_or_else(error)?;
        if bytes[end-1]!=b'\n' {return Err(error());}
        let value=std::str::from_utf8(&bytes[space+1..end-1]).map_err(|_|error())?;
        let (key,value)=value.split_once('=').ok_or_else(error)?;
        if !seen.insert(key) {return Err(error());}
        match key {
            "path"=>{if path.replace(value.into()).is_some() {return Err(error());}},
            "linkpath"=>{if link.replace(value.into()).is_some() {return Err(error());}},
            "mtime"|"atime"|"ctime"|"uid"|"gid"|"uname"|"gname"=>{},
            _=>return Err(error()),
        }
        offset=end;
    }
    Ok(())
}
fn extract(archive_path:&Path,stage:&Path,candidate:&CandidateIdentity,expected_sha:&str,current:&dyn Fn()->bool)->Result<PackageMetadata,String> {
    let file=File::open(archive_path).map_err(|_|error())?;
    let reader=LimitedReader{inner:flate2::read::MultiGzDecoder::new(HashingReader{inner:file,hash:Sha256::new(),read:0}),read:0};
    let mut archive=tar::Archive::new(reader);
    let mut actual=HashMap::new();let mut folded=HashSet::new();let mut aliases=HashMap::new();
    let mut expanded=0u64;let mut count=0usize;let mut pending_path=None;let mut pending_link=None;
    for entry in archive.entries().map_err(|_|error())?.raw(true) {
        if !current() {return Err("update_cancelled".into());}
        let mut entry=entry.map_err(|_|error())?;
        count=count.checked_add(1).filter(|n|*n<=MAX_ENTRIES).ok_or_else(error)?;
        let size=entry.header().size().map_err(|_|error())?;
        expanded=bounded_size(expanded,size,MAX_EXPANDED)?;
        let kind=entry.header().entry_type().as_byte();
        if matches!(kind,b'L'|b'K'|b'x') {
            if size>8192 {return Err(error());}
            let mut bytes=Vec::new();entry.read_to_end(&mut bytes).map_err(|_|error())?;
            if kind==b'x' {pax(&bytes,&mut pending_path,&mut pending_link)?;}
            else {
                if bytes.last()!=Some(&0)||bytes[..bytes.len().saturating_sub(1)].contains(&0) {return Err(error());}
                let value=String::from_utf8(bytes[..bytes.len()-1].to_vec()).map_err(|_|error())?;
                if value.len()>MAX_PATH {return Err(error());}
                let slot=if kind==b'L' {&mut pending_path}else{&mut pending_link};
                if slot.replace(value).is_some() {return Err(error());}
            }
            continue;
        }
        let name=pending_path.take().unwrap_or(String::from_utf8(entry.path_bytes().into_owned()).map_err(|_|error())?);
        let name=if kind==b'5' {name.strip_suffix('/').unwrap_or(&name).to_owned()}else{name};
        let components=safe_path(&name)?;
        use unicode_normalization::UnicodeNormalization;
        for count in 1..=components.len() {
            let original=components[..count].join("/");
            let identity:String=original.nfc().flat_map(char::to_lowercase).collect();
            if aliases.insert(identity,original.clone()).is_some_and(|previous|previous!=original) {return Err(error());}
        }
        let folded_name:String=name.nfc().flat_map(char::to_lowercase).collect();
        if !folded.insert(folded_name) {return Err(error());}
        for count in 1..components.len() {
            if actual.get(&components[..count].join("/")).is_some_and(|entry:&InventoryEntry|entry.kind!="directory") {return Err(error());}
        }
        if kind!=b'5'&&actual.keys().any(|path:&String|path.starts_with(&(name.clone()+"/"))) {return Err(error());}
        let target=stage.join(&name);
        // Parent components are native-created directories; links are created only after all entries are authenticated.
        if let Some(parent)=target.parent() {fs::create_dir_all(parent).map_err(|_|error())?;}
        let mode=entry.header().mode().map_err(|_|error())?;
        if mode&0o7000!=0 {return Err(error());}
        let record=match kind {
            0|b'0'=>{
                if pending_link.take().is_some()||name=="leaf-update.json"&&size>MAX_METADATA {return Err(error());}
                let mut output=private_file(&target)?;let mut hash=Sha256::new();let mut written=0;
                let mut buffer=[0u8;65536];
                loop {
                    if !current() {return Err("update_cancelled".into());}
                    let read=entry.read(&mut buffer).map_err(|_|error())?;if read==0 {break;}
                    written=bounded_size(written,read as u64,size)?;
                    output.write_all(&buffer[..read]).map_err(|_|error())?;hash.update(&buffer[..read]);
                }
                if written!=size {return Err(error());}
                output.sync_all().map_err(|_|error())?;
                #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;fs::set_permissions(&target,fs::Permissions::from_mode(if mode&0o111!=0 {0o700}else{0o600})).map_err(|_|error())?;}
                InventoryEntry{path:name.clone(),kind:"file".into(),size,sha256:Some(format!("{:x}",hash.finalize())),target:None,executable:mode&0o111!=0}
            }
            b'5'=>{
                if size!=0||pending_link.take().is_some() {return Err(error());}
                if target.exists() {if !fs::symlink_metadata(&target).map_err(|_|error())?.is_dir() {return Err(error());}}
                else {fs::create_dir(&target).map_err(|_|error())?;}
                #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;fs::set_permissions(&target,fs::Permissions::from_mode(0o700)).map_err(|_|error())?;}
                InventoryEntry{path:name.clone(),kind:"directory".into(),size:0,sha256:None,target:None,executable:false}
            }
            b'2'=>{
                if size!=0||!candidate.platform.starts_with("darwin-") {return Err(error());}
                let link=pending_link.take().or_else(||entry.link_name_bytes().and_then(|bytes|String::from_utf8(bytes.into_owned()).ok())).ok_or_else(error)?;
                InventoryEntry{path:name.clone(),kind:"symlink".into(),size:0,sha256:None,target:Some(link),executable:false}
            }
            _=>return Err(error()),
        };
        actual.insert(name,record);
    }
    if pending_path.is_some()||pending_link.is_some() {return Err(error());}
    // Consume the gzip trailer/CRC and reject another hidden archive or nonzero trailing bytes.
    let mut reader=archive.into_inner();let mut trailing=0usize;let mut buffer=[0u8;4096];
    loop {let read=reader.read(&mut buffer).map_err(|_|error())?;if read==0 {break;}trailing=trailing.checked_add(read).ok_or_else(error)?;
        if trailing>10240||buffer[..read].iter().any(|b|*b!=0) {return Err(error());}}
    if format!("{:x}",reader.inner.get_ref().hash.clone().finalize())!=expected_sha {return Err("update_signature_invalid".into());}
    let metadata_file=stage.join("leaf-update.json");
    if fs::symlink_metadata(&metadata_file).map_err(|_|error())?.len()>MAX_METADATA {return Err(error());}
    let metadata:PackageMetadata=serde_json::from_reader(File::open(metadata_file).map_err(|_|error())?).map_err(|_|error())?;
    if metadata.schema!=1||metadata.product!="Leaf"||metadata.identifier!="studio.leaf.editor"
        || metadata.version!=candidate.version||metadata.platform!=candidate.platform.rsplit_once('-').ok_or_else(error)?.0||metadata.arch!=candidate.arch
        || metadata.root!=if metadata.platform=="darwin" {"Leaf.app"}else{"Leaf"}
        || metadata.inventory.is_empty()||metadata.inventory.len()>=MAX_ENTRIES {return Err(error());}
    actual.remove("leaf-update.json").filter(|entry|entry.kind=="file").ok_or_else(error)?;
    let mut expected=HashMap::new();
    for entry in &metadata.inventory {
        safe_path(&entry.path)?;
        if entry.path.split('/').next()!=Some(metadata.root.as_str())||expected.insert(entry.path.clone(),entry.clone()).is_some() {return Err(error());}
    }
    if actual!=expected {return Err(error());}
    validate_links(&expected,&metadata.root)?;
    #[cfg(unix)] for entry in expected.values().filter(|entry|entry.kind=="symlink") {
        std::os::unix::fs::symlink(entry.target.as_ref().ok_or_else(error)?,stage.join(&entry.path)).map_err(|_|error())?;
    }
    #[cfg(not(unix))] if expected.values().any(|entry|entry.kind=="symlink") {return Err(error());}
    Ok(metadata)
}
fn file_digest(path:&Path,max:u64,current:&dyn Fn()->bool)->Result<(u64,String),String> {
    let mut file=File::open(path).map_err(|_|error())?;let mut hash=Sha256::new();let mut size=0;
    let mut buffer=[0u8;65536];
    loop {
        if !current() {return Err("update_cancelled".into());}
        let read=file.read(&mut buffer).map_err(|_|error())?;if read==0 {break;}
        size=bounded_size(size,read as u64,max)?;hash.update(&buffer[..read]);
    }
    Ok((size,format!("{:x}",hash.finalize())))
}
fn validate_staged(stage:&Path,metadata:&PackageMetadata,candidate:&CandidateIdentity,current:&dyn Fn()->bool)->Result<(),String> {
    let expected:HashMap<_,_>=metadata.inventory.iter().map(|entry|(entry.path.as_str(),entry)).collect();
    let mut seen=HashSet::new();let mut stack=vec![stage.to_path_buf()];let mut expanded=0;
    while let Some(directory)=stack.pop() {
        for entry in fs::read_dir(directory).map_err(|_|error())? {
            if !current() {return Err("update_cancelled".into());}
            let entry=entry.map_err(|_|error())?;let path=entry.path();
            let relative=path.strip_prefix(stage).map_err(|_|error())?.to_str().ok_or_else(error)?.replace('\\',"/");
            if relative=="leaf-update.json" {continue;}
            safe_path(&relative)?;
            let expected=expected.get(relative.as_str()).ok_or_else(error)?;
            if !seen.insert(relative)||seen.len()>MAX_ENTRIES {return Err(error());}
            let stat=fs::symlink_metadata(&path).map_err(|_|error())?;
            if stat.file_type().is_symlink() {
                if expected.kind!="symlink"||fs::read_link(&path).map_err(|_|error())?.to_str()!=expected.target.as_deref() {return Err(error());}
            } else if stat.is_dir() {
                if expected.kind!="directory" {return Err(error());}stack.push(path);
            } else if stat.is_file() {
                #[cfg(unix)] {use std::os::unix::fs::MetadataExt;if stat.nlink()!=1 {return Err(error());}}
                let (size,sha)=file_digest(&path,MAX_EXPANDED,current)?;
                expanded=bounded_size(expanded,size,MAX_EXPANDED)?;
                if expected.kind!="file"||expected.size!=size||expected.sha256.as_deref()!=Some(&sha) {return Err(error());}
                #[cfg(unix)] {use std::os::unix::fs::MetadataExt;if (stat.mode()&0o111!=0)!=expected.executable {return Err(error());}}
            } else {return Err(error());}
        }
    }
    if seen.len()!=expected.len() {return Err(error());}
    let paths=if metadata.platform=="darwin" {["Leaf.app/Contents/MacOS/leaf","Leaf.app/Contents/MacOS/leaf-mcp-adapter"]}
        else {["Leaf/leaf.exe","Leaf/leaf-mcp-adapter.exe"]};
    for (path,role) in paths.into_iter().zip(["leaf","leaf-mcp-adapter"]) {
        if expected.get(path).is_none_or(|entry|entry.kind!="file"||!entry.executable) {return Err(error());}
        binary_identity(&stage.join(path),&metadata.version,&metadata.platform,&metadata.arch,role,current)?;
    }
    if metadata.platform=="darwin" {
        let path=stage.join("Leaf.app/Contents/Info.plist");
        if fs::metadata(&path).map_err(|_|error())?.len()>1024*1024 {return Err(error());}
        let plist=plist::Value::from_reader(File::open(path).map_err(|_|error())?).map_err(|_|error())?;
        let dict=plist.as_dictionary().ok_or_else(error)?;
        for (key,value) in [("CFBundleIdentifier","studio.leaf.editor"),("CFBundleShortVersionString",candidate.version.as_str()),("CFBundleExecutable","leaf")] {
            if dict.get(key).and_then(plist::Value::as_string)!=Some(value) {return Err(error());}
        }
    }
    Ok(())
}
fn binary_identity(path:&Path,version:&str,platform:&str,arch:&str,role:&str,current:&dyn Fn()->bool)->Result<(),String> {
    let mut file=File::open(path).map_err(|_|error())?;
    let mut head=[0u8;4096];let size=file.read(&mut head).map_err(|_|error())?;
    let head=&head[..size];
    if platform=="darwin" {
        let expected=match arch {"aarch64"=>0x0100000cu32,"x86_64"=>0x01000007u32,_=>return Err(error())};
        let valid=if head.len()>=32&&head[..4]==[0xcf,0xfa,0xed,0xfe] {
            u32::from_le_bytes(head[4..8].try_into().unwrap())==expected&&u32::from_le_bytes(head[12..16].try_into().unwrap())==2
        } else if head.len()>=8&&head[..4]==[0xca,0xfe,0xba,0xbe] {
            let count=u32::from_be_bytes(head[4..8].try_into().unwrap()) as usize;
            if count==0||count>16||head.len()<8+count*20 {return Err(error());}
            use std::io::{Seek,SeekFrom};
            let length=file.metadata().map_err(|_|error())?.len();let mut found=false;
            for index in 0..count {
                let record=&head[8+index*20..8+(index+1)*20];
                let cpu=u32::from_be_bytes(record[..4].try_into().unwrap());
                let offset=u32::from_be_bytes(record[8..12].try_into().unwrap()) as u64;
                let size=u32::from_be_bytes(record[12..16].try_into().unwrap()) as u64;
                if offset.checked_add(size).is_none_or(|end|end>length)||size<32 {return Err(error());}
                if cpu==expected {
                    file.seek(SeekFrom::Start(offset)).map_err(|_|error())?;let mut thin=[0u8;32];file.read_exact(&mut thin).map_err(|_|error())?;
                    if thin[..4]!=[0xcf,0xfa,0xed,0xfe]||u32::from_le_bytes(thin[4..8].try_into().unwrap())!=expected||u32::from_le_bytes(thin[12..16].try_into().unwrap())!=2 {return Err(error());}
                    found=true;
                }
            }found
        } else {false};
        if !valid {return Err(error());}
    } else if platform=="windows" {
        if head.len()<64||&head[..2]!=b"MZ" {return Err(error());}
        let offset=u32::from_le_bytes(head[60..64].try_into().unwrap()) as usize;
        if offset.checked_add(26).is_none_or(|end|end>head.len())||&head[offset..offset+4]!=b"PE\0\0" {return Err(error());}
        let expected=match arch {"aarch64"=>0xaa64u16,"x86_64"=>0x8664u16,_=>return Err(error())};
        let characteristics=u16::from_le_bytes(head[offset+22..offset+24].try_into().unwrap());
        if u16::from_le_bytes(head[offset+4..offset+6].try_into().unwrap())!=expected||characteristics&2==0||characteristics&0x2000!=0
            ||u16::from_le_bytes(head[offset+24..offset+26].try_into().unwrap())!=0x20b {return Err(error());}
    } else {return Err(error());}
    use std::io::{Seek,SeekFrom};file.seek(SeekFrom::Start(0)).map_err(|_|error())?;
    // Decode the search delimiter at runtime: embedding it literally here would match the verifier inside Leaf itself.
    let prefix:Vec<u8>=std::hint::black_box([233,224,228,227,250,240,245,225,228,241,224,250,231,236,235,228,247,252,250,236,225,224,235,241,236,241,252,250,243,148,165]).into_iter().map(|byte|byte^165).collect();
    let mut expected=prefix.clone();
    for field in ["Leaf","studio.leaf.editor",version,role] {expected.extend_from_slice(field.as_bytes());expected.push(0);}
    let mut buffer=vec![0u8;65536];let mut tail=Vec::new();let mut found=false;
    loop {
        if !current() {return Err("update_cancelled".into());}
        let read=file.read(&mut buffer).map_err(|_|error())?;
        tail.extend_from_slice(&buffer[..read]);
        loop {
            let Some(start)=tail.windows(prefix.len()).position(|bytes|bytes==prefix) else {
                if tail.len()>=prefix.len() {tail=tail.split_off(tail.len()-prefix.len()+1);}
                break;
            };
            if start>0 {tail.drain(..start);}
            let mut zeros=0;let mut end=None;
            for (index,byte) in tail.iter().enumerate().skip(prefix.len()) {
                if *byte==0 {zeros+=1;if zeros==4 {end=Some(index+1);break;}}
            }
            let Some(end)=end else {if tail.len()>512||read==0 {return Err(error());}break;};
            if tail[..end]!=expected {return Err(error());}
            found=true;tail.drain(..end);
        }
        if read==0 {break;}
    }
    if !found {return Err(error());}Ok(())
}

#[cfg(any(test,feature="native-smoke"))]
fn read_private(path:&Path,max:u64)->Result<Vec<u8>,String> {
    let stat=fs::symlink_metadata(path).map_err(|_|error())?;
    if !stat.is_file()||stat.file_type().is_symlink()||stat.len()>max {return Err(error());}
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        let probe=tempfile::tempfile().map_err(|_|error())?.metadata().map_err(|_|error())?;
        if stat.nlink()!=1||stat.uid()!=probe.uid()||stat.mode()&0o022!=0 {return Err(error());}
    }
    fs::read(path).map_err(|_|error())
}
#[cfg(feature="native-smoke")]
pub fn fixture_input()->Result<(PathBuf,CandidateIdentity,Trust),String> {
    if !crate::update_test_driver::package_fixture_enabled() {return Err("test_disabled".into());}
    let proposed=PathBuf::from(std::env::var_os("LEAF_UPDATE_PACKAGE_TEST_ROOT").ok_or("update_fixture_root_required")?);
    let stat=fs::symlink_metadata(&proposed).map_err(|_|error())?;
    if !stat.is_dir()||stat.file_type().is_symlink() {return Err(error());}
    #[cfg(unix)] {use std::os::unix::fs::MetadataExt;
        let probe=tempfile::tempfile().map_err(|_|error())?.metadata().map_err(|_|error())?;
        if stat.mode()&0o077!=0||stat.uid()!=probe.uid() {return Err(error());}}
    let root=proposed.canonicalize().map_err(|_|error())?;
    let temporary=std::env::temp_dir().canonicalize().map_err(|_|error())?;
    let name=root.file_name().and_then(|name|name.to_str()).ok_or_else(error)?;
    if !root.starts_with(&temporary)||!name.strip_prefix("leaf-update-test-").is_some_and(|suffix|!suffix.is_empty()&&suffix.bytes().all(|b|b.is_ascii_alphanumeric()||b"_-".contains(&b))) {return Err(error());}
    let evidence=root.join("evidence");let evidence_stat=fs::symlink_metadata(&evidence).map_err(|_|error())?;
    if !evidence_stat.is_dir()||evidence_stat.file_type().is_symlink() {return Err(error());}
    #[cfg(unix)] {use std::os::unix::fs::MetadataExt;if evidence_stat.mode()&0o077!=0||evidence_stat.uid()!=stat.uid() {return Err(error());}}
    let binding:FixtureBinding=serde_json::from_slice(&read_private(&root.join("payload-binding.json"),65536)?).map_err(|_|error())?;
    if binding.mode!="TEST-ONLY-THROWAWAY"||binding.run_id.len()!=36||binding.fingerprint.len()!=64
        ||binding.file.is_empty()||binding.file.len()>255||!binding.file.bytes().all(|b|b.is_ascii_alphanumeric()||b"._-".contains(&b))
        ||binding.file.contains(['/', '\\'])||binding.file=="."||binding.file==".."||binding.size==0||binding.size>MAX_DOWNLOAD
        ||binding.platform!=crate::update_releases::os()||binding.arch!=std::env::consts::ARCH {return Err(error());}
    let manifest:serde_json::Value=serde_json::from_slice(&read_private(&root.join("run-manifest.json"),65536)?).map_err(|_|error())?;
    for (key,expected) in [("mode",binding.mode.as_str()),("runId",binding.run_id.as_str()),("fingerprint",binding.fingerprint.as_str()),
        ("version",binding.version.as_str()),("platform",binding.platform.as_str()),("arch",binding.arch.as_str())] {
        if manifest[key].as_str()!=Some(expected) {return Err(error());}
    }
    let created=manifest["createdMs"].as_u64().ok_or_else(error)?;
    let payload=root.join(&binding.file);
    let stat=fs::symlink_metadata(&payload).map_err(|_|error())?;
    if !stat.is_file()||stat.file_type().is_symlink()||stat.len()==0||stat.len()>MAX_DOWNLOAD {return Err(error());}
    #[cfg(unix)] {use std::os::unix::fs::MetadataExt;if stat.nlink()!=1||stat.mode()&0o022!=0 {return Err(error());}}
    let millis=|time:std::time::SystemTime|->Result<u64,String>{Ok(time.duration_since(std::time::UNIX_EPOCH).map_err(|_|error())?.as_millis().try_into().map_err(|_|error())?)};
    if millis(stat.created().map_err(|_|error())?)?<created||millis(stat.modified().map_err(|_|error())?)?<created {return Err("update_fixture_not_fresh".into());}
    let public_key=String::from_utf8(read_private(&root.join("signer-public.key"),8192)?).map_err(|_|error())?;
    let (_,fingerprint,fixture)=decode_public(&public_key)?;
    let text=decode_text(&public_key,8192)?;
    let raw=base64::engine::general_purpose::STANDARD.decode(text.lines().nth(1).ok_or_else(error)?).map_err(|_|error())?;
    if !fixture||&raw[2..10]!=b"TESTONLY"||fingerprint!=binding.fingerprint {return Err(error());}
    let signature=String::from_utf8(read_private(&root.join("evidence/payload.sig"),16384)?).map_err(|_|error())?;
    let candidate=CandidateIdentity{release_id:1,tag:format!("v{}",binding.version),version:binding.version.clone(),
        platform:format!("{}-{}",binding.platform,binding.arch),arch:binding.arch.clone(),manifest_asset_id:11,asset_id:12,
        asset_name:binding.file.clone(),url:format!("https://github.com/CoozeeWang/leaf-markdown/releases/download/v{}/{}",binding.version,binding.file),signature};
    let trust=Trust::Fixture{public_key,binding,run_root:root.clone()};
    Ok((payload,candidate,trust))
}
#[cfg(feature="native-smoke")]
pub fn fixture_verify(app_instance:[u8;16])->Result<Arc<VerifiedPackage>,String> {
    let (payload,candidate,trust)=fixture_input()?;
    let root=payload.parent().ok_or_else(error)?;
    // Crosscheck freshly built bytes with the locked official verifier BEFORE native staging consumes them.
    let sha256=authenticate_file(&payload,&candidate,&trust,&||true)?;
    let evidence=root.join("evidence/official-verifier.json");
    let mut result=private_file(&evidence)?;
    result.write_all(br#"{"status":"passed","verifier":"minisign-verify","version":"0.3.0","scope":"fresh run-bound payload and trusted metadata"}"#).map_err(|_|error())?;
    result.sync_all().map_err(|_|error())?;
    let cache=root.join("native-cache");private_directory(&cache)?;
    let temporary=tempfile::Builder::new().prefix("verified-").tempdir_in(cache).map_err(|_|error())?;
    fs::copy(&payload,temporary.path().join("verified.tar.gz")).map_err(|_|error())?;
    let staged=temporary.path().join("stage");fs::create_dir(&staged).map_err(|_|error())?;
    let metadata=extract(&temporary.path().join("verified.tar.gz"),&staged,&candidate,&sha256,&||true)?;
    validate_staged(&staged,&metadata,&candidate,&||true)?;
    let mut id=[0;16];getrandom::fill(&mut id).map_err(|_|error())?;
    let package=Arc::new(VerifiedPackage{id,app_instance,candidate,sha256,private_root:temporary,metadata,trust,consumed:std::sync::atomic::AtomicBool::new(false)});
    package.revalidate(&||true)?;
    Ok(package)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rejects_untrusted_archive_paths() {
        for path in ["../outside","/absolute","C:/drive","\\\\host\\share","Leaf.app/../outside","Leaf.app//file","Leaf.app/NUL.txt","Leaf.app/file:stream","Leaf.app/final.","Leaf.app/zero\0"] {
            assert!(safe_path(path).is_err(),"unsafe archive member must be rejected: {path}");
        }
        assert!(safe_path("Leaf.app/Contents/MacOS/leaf").is_ok());
    }
    #[test] fn exact_limits_and_checked_overflow() {
        for maximum in [MAX_DOWNLOAD,MAX_EXPANDED] {
            assert_eq!(bounded_size(maximum-1,1,maximum).unwrap(),maximum);
            assert!(bounded_size(maximum,1,maximum).is_err());
            assert!(bounded_size(u64::MAX,1,maximum).is_err());
        }
        let exact=format!("Leaf/{}",vec!["x".repeat(131);31].join("/"));
        assert_eq!(exact.len(),MAX_PATH);assert!(safe_path(&exact).is_ok());
        assert!(safe_path(&(exact.clone()+"x")).is_err());assert!(safe_path(&(exact+"/x")).is_err());
    }
    fn directory(path:&str)->InventoryEntry {InventoryEntry{path:path.into(),kind:"directory".into(),size:0,sha256:None,target:None,executable:false}}
    fn link(path:&str,target:&str)->InventoryEntry {InventoryEntry{path:path.into(),kind:"symlink".into(),size:0,sha256:None,target:Some(target.into()),executable:false}}
    #[test] fn relative_symlinks_resolve_without_cycles_or_escapes() {
        let root=directory("Leaf.app");let contents=directory("Leaf.app/Contents");
        let version=directory("Leaf.app/Contents/A");let current=link("Leaf.app/Contents/Current","A");
        let mut map:HashMap<_,_>=[root,contents,version,current].into_iter().map(|entry|(entry.path.clone(),entry)).collect();
        assert!(validate_links(&map,"Leaf.app").is_ok());
        for target in [".","..","../Current"] {
            let mut ancestor=map.clone();
            ancestor.insert("Leaf.app/Contents/A/back".into(),link("Leaf.app/Contents/A/back",target));
            assert!(validate_links(&ancestor,"Leaf.app").is_err(),"directory cycle {target}");
        }
        let mut siblings=map.clone();
        siblings.insert("Leaf.app/Contents/B".into(),directory("Leaf.app/Contents/B"));
        siblings.insert("Leaf.app/Contents/A/toB".into(),link("Leaf.app/Contents/A/toB","../B"));
        assert!(validate_links(&siblings,"Leaf.app").is_ok());
        siblings.insert("Leaf.app/Contents/B/toA".into(),link("Leaf.app/Contents/B/toA","../A"));
        assert!(validate_links(&siblings,"Leaf.app").is_err());
        map.insert("Leaf.app/Contents/A".into(),link("Leaf.app/Contents/A","Current"));
        assert!(validate_links(&map,"Leaf.app").is_err());
        assert!(normalized_link("Leaf.app/Contents/Current","../../outside","Leaf.app").is_err());
        assert!(normalized_link("Leaf.app/Contents/Current","/outside","Leaf.app").is_err());
    }
    #[test] fn startup_configuration_deserializes_and_requires_all_trust_fields() {
        let config:tauri::utils::config::Config=serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let value=config.plugins.0.get("leafUpdater").unwrap().clone();
        assert!(matches!(Trust::from_config(value.clone()).unwrap(),Trust::Production{fingerprint,..} if fingerprint == value["provenance"]["fingerprint"].as_str().unwrap()));
        for field in ["schema","status","owner","pubkey","provenance"] {
            let mut incomplete=value.clone();incomplete.as_object_mut().unwrap().remove(field);
            assert!(Trust::from_config(incomplete).is_err(),"mandatory field {field}");
        }
    }
    #[test] fn production_identity_is_explicit_and_never_a_fixture() {
        let pending=serde_json::json!({"schema":1,"status":"pending_external_identity","owner":"Leaf release custodian","pubkey":null,"provenance":null});
        assert!(matches!(Trust::from_config(pending).unwrap(),Trust::Pending));
        for invalid in [serde_json::json!({}),serde_json::json!({"schema":1,"status":"ready","owner":"Leaf release custodian","pubkey":null,"provenance":null})] {
            assert!(Trust::from_config(invalid).is_err());
        }
        assert_eq!(Trust::Pending.key().err().as_deref(),Some("update_signing_identity_pending"));
    }
    #[test] fn pax_overrides_are_bounded_unique_and_cannot_override_size() {
        let mut path=None;let mut link=None;
        assert!(pax(b"14 size=123456\n",&mut path,&mut link).is_err());
        assert!(pax(b"999 path=Leaf.app/file\n",&mut path,&mut link).is_err());
    }

    #[test]
    #[ignore = "release custodian supplies a signed production artifact for explicit verification"]
    fn custodian_production_artifact_verifies() {
        let path=PathBuf::from(std::env::var("LEAF_RELEASE_VERIFY_PACKAGE").expect("production artifact required"));
        let signature=fs::read_to_string(std::env::var("LEAF_RELEASE_VERIFY_SIGNATURE").expect("signature required")).unwrap();
        let platform=std::env::var("LEAF_RELEASE_VERIFY_PLATFORM").expect("platform required");
        let arch=platform.rsplit_once('-').unwrap().1.to_owned();
        let config:tauri::utils::config::Config=serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let trust=Trust::from_config(config.plugins.0.get("leafUpdater").unwrap().clone()).unwrap();
        assert!(matches!(trust,Trust::Production{..}));
        let version=env!("CARGO_PKG_VERSION").to_owned();
        let name=path.file_name().unwrap().to_str().unwrap().to_owned();
        let candidate=CandidateIdentity{release_id:1,tag:format!("v{version}"),version:version.clone(),platform,arch,
            manifest_asset_id:1,asset_id:2,asset_name:name.clone(),
            url:format!("https://github.com/CoozeeWang/leaf-markdown/releases/download/v{version}/{name}"),signature};
        let hash=authenticate_file(&path,&candidate,&trust,&||true).unwrap();
        let root=tempfile::tempdir().unwrap();let stage=root.path().join("stage");fs::create_dir(&stage).unwrap();
        let metadata=extract(&path,&stage,&candidate,&hash,&||true).unwrap();
        validate_staged(&stage,&metadata,&candidate,&||true).unwrap();
        let mut wrong=candidate.clone();wrong.version="999.0.0".into();
        assert!(authenticate_file(&path,&wrong,&trust,&||true).is_err(),"signed version binding");
        let corrupt=root.path().join("corrupt.tar.gz");let mut bytes=fs::read(&path).unwrap();bytes[0]^=1;fs::write(&corrupt,bytes).unwrap();
        assert!(authenticate_file(&corrupt,&candidate,&trust,&||true).is_err(),"tampered payload");
    }
}
