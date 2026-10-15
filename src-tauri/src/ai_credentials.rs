//! OpenAI keys stay in the GUI-only OS keyring. Local session bearers use owner-only files.
//! Serialized profiles and descriptors contain opaque references, never secrets.
use std::{collections::HashMap, path::PathBuf, io::Write};
use serde::{Serialize, Deserialize};
use sha2::{Digest, Sha256};

pub const CLIENTS: [&str; 3] = ["chatgpt", "claude-desktop", "workbuddy"];
// User intent is durable; process bearers, document grants and tasks are not.
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpPreferences { pub enabled: bool }
impl McpPreferences {
    pub fn load(path:&std::path::Path)->Result<Self,String> {
        match std::fs::read(path) {
            Ok(bytes)=>serde_json::from_slice(&bytes).map_err(|_|"mcp_preference_invalid".into()),
            Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(Self::default()),
            Err(_)=>Err("mcp_preference_read".into()),
        }
    }
    pub fn save(&self,path:&std::path::Path)->Result<(),String> {
        write_private(path,&serde_json::to_string(self).map_err(|_|"mcp_preference_write")?).map_err(|_|"mcp_preference_write".into())
    }
}
pub fn native_build_identity()->String {
    let mut hash=Sha256::new();
    for source in [include_str!("ai_credentials.rs"),include_str!("atomic_file.rs"),include_str!("ai_client_install.rs"),include_str!("claude_stdio.cjs"),include_str!("mcp.rs"),include_str!("chatgpt_tunnel.rs"),include_str!("main.rs"),include_str!("bin/leaf-mcp-adapter.rs"),include_str!("../Cargo.toml")] {hash.update(source.as_bytes());}
    format!("{}:{:x}:{}:{}:{}:{}",env!("CARGO_PKG_VERSION"),hash.finalize(),std::env::consts::OS,std::env::consts::ARCH,if cfg!(feature="native-smoke"){"native-smoke"}else{"production"},if cfg!(debug_assertions){"debug"}else{"release"})
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CredentialRef { pub service: String, pub account: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerDescriptor {pub uri:String,pub client:String,pub generation:u64,pub instance:String,#[serde(default)]pub credential_file:Option<PathBuf>,pub credential_ref:CredentialRef}
#[derive(Clone,Serialize,Deserialize)]
pub struct BoundCredential {pub token:String,pub uri:String,pub instance:String,pub generation:u64,#[serde(default)]pub external_secret:Option<String>}
impl BrokerDescriptor {
    pub fn validate(&self)->Result<(),String> {
        let port=self.uri.strip_prefix("http://127.0.0.1:").and_then(|s|s.strip_suffix("/mcp")).ok_or("invalid_broker_descriptor")?;
        if port.parse::<u16>().ok().is_none_or(|p|p==0)||!port.bytes().all(|b|b.is_ascii_digit())||!CLIENTS.contains(&self.client.as_str())||!self.credential_ref.service.starts_with("studio.leaf.")||!self.credential_ref.service.ends_with(".mcp")||!self.credential_ref.account.starts_with(&format!("{}-",self.client))||self.instance.len()!=64 {return Err("invalid_broker_descriptor".into());}Ok(())
    }
    pub fn load_token(&self)->Result<String,String> {
        self.validate()?;
        // Current descriptors use a private, instance-bound local bearer file.
        // Only legacy descriptors retain the bounded Keychain migration path.
        let payload=if let Some(path)=&self.credential_file {read_private(path)?}else{self.credential_ref.load()?};
        let bound:BoundCredential=serde_json::from_str(&payload).map_err(|_|"credential_unbound")?;
        if bound.uri!=self.uri||bound.instance!=self.instance||bound.generation!=self.generation {return Err("stale_broker_descriptor".into());}Ok(bound.token)
    }
}
impl CredentialRef {
    fn entry(&self) -> Result<keyring::Entry, String> {
        if !self.service.starts_with("studio.leaf.")||!self.service.ends_with(".mcp")||!CLIENTS.iter().any(|c|self.account.starts_with(&format!("{c}-"))){return Err("invalid_shared_credential".into());}
        keyring::Entry::new(&self.service, &self.account).map_err(|_| "credential_unavailable".into())
    }
    pub fn load(&self) -> Result<String, String> {
        self.entry()?.get_password().map_err(|error| {
            #[cfg(all(target_os="macos",feature="native-smoke"))]
            if let keyring::Error::PlatformFailure(native)=&error {
                if let Some(native)=native.downcast_ref::<security_framework::base::Error>() {
                    if let Some(path)=std::env::var_os("LEAF_MCP_TEST_TRACE") {let _=std::fs::write(path,format!("keyring_os_status:{}",native.code()));}
                }
            }
            let _=error;"credential_unavailable".into()
        })
    }
}
pub trait SecretStore: Send + Sync {
    fn set(&self, reference: &CredentialRef, secret: &str) -> Result<(), String>;
    fn get(&self, reference: &CredentialRef) -> Result<String, String>;
    fn delete(&self, reference: &CredentialRef) -> Result<(), String>;
}
pub struct OsKeyring;
impl SecretStore for OsKeyring {
    fn set(&self, r: &CredentialRef, s: &str) -> Result<(), String> {
        #[cfg(target_os="macos")]
        create_mac_shared_entry(r,s)?;
        r.entry()?.set_password(s).map_err(|_| "credential_unavailable".into())
    }
    fn get(&self, r: &CredentialRef) -> Result<String, String> { r.load() }
    fn delete(&self, r: &CredentialRef) -> Result<(), String> {
        match r.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("credential_unavailable".into()),
        }
    }
}

// Local broker bearers live only in this process and in owner-only session files.
// They are unrelated to the user's OpenAI API key and never need Keychain ACLs.
#[derive(Default)]pub struct SessionSecrets;
fn session_secrets()->&'static std::sync::Mutex<HashMap<String,String>> {static CACHE:std::sync::OnceLock<std::sync::Mutex<HashMap<String,String>>>=std::sync::OnceLock::new();CACHE.get_or_init(Default::default)}
fn secret_id(r:&CredentialRef)->String {format!("{}:{}",r.service,r.account)}
impl SecretStore for SessionSecrets {
 fn set(&self,r:&CredentialRef,s:&str)->Result<(),String>{session_secrets().lock().unwrap().insert(secret_id(r),s.into());Ok(())}
 fn get(&self,r:&CredentialRef)->Result<String,String>{session_secrets().lock().unwrap().get(&secret_id(r)).cloned().ok_or("credential_unavailable".into())}
 fn delete(&self,r:&CredentialRef)->Result<(),String>{session_secrets().lock().unwrap().remove(&secret_id(r));Ok(())}
}
pub fn private_directory(path:&std::path::Path)->Result<(),String>{
 if std::fs::symlink_metadata(path).is_ok_and(|m|m.file_type().is_symlink()){return Err("unsafe_credential_path".into());}
 std::fs::create_dir_all(path).map_err(|_|"credential_write")?;
 #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(path,std::fs::Permissions::from_mode(0o700)).map_err(|_|"credential_write")?;}
 #[cfg(windows)]protect_windows(path)?;
 Ok(())
}
pub fn write_private(path:&std::path::Path,text:&str)->Result<(),String>{
 let parent=path.parent().ok_or("credential_write")?;private_directory(parent)?;
 write_private_existing_parent(path,text)
}
// Host configuration directories belong to the host; preserve their permissions.
pub fn write_private_existing_parent(path:&std::path::Path,text:&str)->Result<(),String>{
 let parent=path.parent().ok_or("credential_write")?;
 let metadata=std::fs::symlink_metadata(parent).map_err(|_|"credential_write")?;
 if !metadata.is_dir()||metadata.file_type().is_symlink(){return Err("unsafe_credential_path".into());}
 if std::fs::symlink_metadata(path).is_ok_and(|m|m.file_type().is_symlink()){return Err("unsafe_credential_path".into());}
 let mut f=tempfile::NamedTempFile::new_in(parent).map_err(|_|"credential_write")?;
 #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;f.as_file().set_permissions(std::fs::Permissions::from_mode(0o600)).map_err(|_|"credential_write")?;}
 #[cfg(windows)]protect_windows(f.path())?;
 f.write_all(text.as_bytes()).and_then(|_|f.as_file().sync_all()).map_err(|_|"credential_write")?;crate::atomic_file::persist(f,path).map_err(|_|"credential_write")?;Ok(())
}
pub fn read_private(path:&std::path::Path)->Result<String,String>{
 let metadata=std::fs::symlink_metadata(path).map_err(|_|"credential_unavailable")?;
 if !metadata.is_file()||metadata.file_type().is_symlink()||metadata.len()>65536{return Err("unsafe_credential_path".into());}
 #[cfg(unix)]{use std::os::unix::fs::MetadataExt;unsafe extern "C"{fn getuid()->u32;}if metadata.mode()&0o077!=0||metadata.uid()!=unsafe{getuid()}{return Err("unsafe_credential_path".into());}}
 std::fs::read_to_string(path).map_err(|_|"credential_unavailable".into())
}
#[cfg(windows)]fn protect_windows(path:&std::path::Path)->Result<(),String>{
 use std::process::{Command,Stdio};
 let user=Command::new("whoami.exe").args(["/user","/fo","csv","/nh"]).output().map_err(|_|"credential_permissions")?;
 let sid=String::from_utf8_lossy(&user.stdout).split(',').last().unwrap_or("").trim().trim_matches('"').to_string();
 if !sid.starts_with("S-1-")||!sid.bytes().all(|b|b.is_ascii_digit()||b==b'S'||b==b'-'){return Err("credential_permissions".into());}
 // Directories must pass the current user's access to files/subdirectories.
 // A non-inheritable grant can strip inherited access from existing siblings
 // when the master preference first protects their shared application folder.
 let permission=if path.is_dir(){format!("*{sid}:(OI)(CI)F")}else{format!("*{sid}:F")};
 if !Command::new("icacls.exe").arg(path).args(["/inheritance:r","/grant:r",&permission]).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s|s.success()){return Err("credential_permissions".into());}Ok(())
}
fn runtime_cache()->&'static std::sync::Mutex<HashMap<String,String>> {static CACHE:std::sync::OnceLock<std::sync::Mutex<HashMap<String,String>>>=std::sync::OnceLock::new();CACHE.get_or_init(Default::default)}
// Keyring's macOS setter creates a caller-only ACL. For NEW Leaf entries use
// Apple's public creation API with exactly the GUI and its sibling helper.
// Existing entries keep their ACL; no login keychain or other item is changed.
#[cfg(target_os="macos")]
fn create_mac_shared_entry(reference:&CredentialRef,secret:&str)->Result<(),String> {
    create_mac_entry(reference,secret,true)
}
#[cfg(target_os="macos")]
fn create_mac_gui_only_entry(reference:&RuntimeCredentialRef,secret:&str)->Result<(),String> {
    create_mac_entry(&CredentialRef{service:reference.service.clone(),account:reference.account.clone()},secret,false)
}
#[cfg(target_os="macos")]
fn create_mac_entry(reference:&CredentialRef,secret:&str,share_helper:bool)->Result<(),String> {
    use std::{ffi::{c_void,c_char,CString},ptr};
    type Ref=*const c_void;
    #[repr(C)]struct Attribute {tag:u32,length:u32,data:*mut c_void}
    #[repr(C)]struct Attributes {count:u32,attr:*mut Attribute}
    #[link(name="Security",kind="framework")]
    unsafe extern "C" {
        fn SecTrustedApplicationCreateFromPath(path:*const c_char,out:*mut Ref)->i32;
        fn SecAccessCreate(description:Ref,trusted:Ref,out:*mut Ref)->i32;
        fn SecKeychainItemCreateFromContent(class:u32,attrs:*const Attributes,length:u32,data:*const c_void,keychain:Ref,access:Ref,item:*mut Ref)->i32;
        #[cfg(feature="native-smoke")]fn SecKeychainItemCopyAccess(item:Ref,out:*mut Ref)->i32;
        #[cfg(feature="native-smoke")]fn SecAccessCopyACLList(access:Ref,out:*mut Ref)->i32;
        #[cfg(feature="native-smoke")]fn SecACLCopyContents(acl:Ref,apps:*mut Ref,description:*mut Ref,flags:*mut u16)->i32;
    }
    #[link(name="CoreFoundation",kind="framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(allocator:Ref,string:*const c_char,encoding:u32)->Ref;
        fn CFArrayCreate(allocator:Ref,values:*const Ref,count:isize,callbacks:Ref)->Ref;
        fn CFRelease(value:Ref);
        #[cfg(feature="native-smoke")]fn CFArrayGetCount(array:Ref)->isize;
        #[cfg(feature="native-smoke")]fn CFArrayGetValueAtIndex(array:Ref,index:isize)->Ref;
    }
    struct Owned(Ref);impl Drop for Owned {fn drop(&mut self){if !self.0.is_null(){unsafe{CFRelease(self.0)}}}}
    let executable=std::env::current_exe().map_err(|_|"credential_unavailable")?;
    // The broker alone creates credentials. The helper never configures them.
    if executable.file_stem().is_none_or(|s|s!="leaf") {return Err("credential_unavailable".into());}
    let helper=executable.parent().ok_or("credential_unavailable")?.join("leaf-mcp-adapter");
    if share_helper&&!helper.is_file() {return Err("helper_not_installed".into());}
    let helper=CString::new(helper.as_os_str().as_encoded_bytes()).map_err(|_|"credential_unavailable")?;
    let description=CString::new("Leaf MCP connection").unwrap();
    unsafe {
        let mut gui=ptr::null();let mut adapter=ptr::null();
        if SecTrustedApplicationCreateFromPath(ptr::null(),&mut gui)!=0 {return Err("credential_unavailable".into());}
        let gui=Owned(gui);
        if share_helper&&SecTrustedApplicationCreateFromPath(helper.as_ptr(),&mut adapter)!=0 {return Err("credential_unavailable".into());}
        let adapter=Owned(adapter);let values=[gui.0,adapter.0];
        let trusted=Owned(CFArrayCreate(ptr::null(),values.as_ptr(),if share_helper{2}else{1},ptr::null()));
        let description=Owned(CFStringCreateWithCString(ptr::null(),description.as_ptr(),0x08000100));
        if trusted.0.is_null()||description.0.is_null(){return Err("credential_unavailable".into());}
        let mut access=ptr::null();if SecAccessCreate(description.0,trusted.0,&mut access)!=0{return Err("credential_unavailable".into());}
        let access=Owned(access);
        let mut attributes=[Attribute{tag:u32::from_be_bytes(*b"svce"),length:reference.service.len() as u32,data:reference.service.as_ptr() as *mut c_void},Attribute{tag:u32::from_be_bytes(*b"acct"),length:reference.account.len() as u32,data:reference.account.as_ptr() as *mut c_void}];
        let attributes=Attributes{count:2,attr:attributes.as_mut_ptr()};let mut item=ptr::null();
        let status=SecKeychainItemCreateFromContent(u32::from_be_bytes(*b"genp"),&attributes,secret.len() as u32,secret.as_ptr().cast(),ptr::null(),access.0,&mut item);
        let _item=Owned(item);
        if status!=0&&status != -25299 {return Err("credential_unavailable".into());}
        #[cfg(feature="native-smoke")]
        if status==0 {
            let mut actual=ptr::null();let mut list=ptr::null();
            if SecKeychainItemCopyAccess(item,&mut actual)==0 {
                let actual=Owned(actual);
                if SecAccessCopyACLList(actual.0,&mut list)==0 {
                    let list=Owned(list);let mut evidence=Vec::new();
                    for i in 0..CFArrayGetCount(list.0) {
                        let mut apps=ptr::null();let mut text=ptr::null();let mut flags=0;
                        if SecACLCopyContents(CFArrayGetValueAtIndex(list.0,i),&mut apps,&mut text,&mut flags)==0 {
                            let apps=Owned(apps);let _text=Owned(text);
                            evidence.push(serde_json::json!({"trusted_apps":if apps.0.is_null(){-1}else{CFArrayGetCount(apps.0)},"prompt_flags":flags}));
                        }
                    }
                    if let Some(root)=std::env::var_os("LEAF_MCP_TEST_DIR") {let _=std::fs::write(PathBuf::from(root).join(if share_helper{"acl-effective.json"}else{"acl-runtime-effective.json"}),serde_json::to_vec(&evidence).unwrap());}
                }
            }
        }
    }Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AiClientProfile {
    pub client: String,
    pub configured: bool,
    pub enabled: bool,
    pub generation: u64,
    pub credential_ref: Option<CredentialRef>,
    #[serde(default)] pub tunnel:Option<TunnelProfile>,
    #[serde(default)] pub has_runtime_key:bool,
    #[serde(default)] pub(crate) runtime_ref:Option<RuntimeCredentialRef>,
    #[serde(default)] pub(crate) runtime_pending:bool,
}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
pub struct TunnelProfile {pub tunnel_id:String,pub executable:PathBuf,pub profile:PathBuf,pub health_file:PathBuf,pub generation:u64,#[serde(default)]pub digest:String}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
pub(crate) struct RuntimeCredentialRef {service:String,account:String}
impl RuntimeCredentialRef {
    fn validate(&self)->Result<(),String>{if self.service.starts_with("studio.leaf.")&&self.service.ends_with(".chatgpt-runtime")&&self.account.starts_with("runtime-"){Ok(())}else{Err("invalid_runtime_reference".into())}}
}
// This capability is deliberately distinct from the helper's SecretStore.
pub(crate) trait RuntimeVault:Send+Sync {
    fn set(&self,r:&RuntimeCredentialRef,key:&str)->Result<(),String>;
    fn get(&self,r:&RuntimeCredentialRef)->Result<String,String>;
    fn delete(&self,r:&RuntimeCredentialRef)->Result<(),String>;
}
pub(crate) struct GuiRuntimeSecretStore;
impl GuiRuntimeSecretStore {
    fn entry(r:&RuntimeCredentialRef)->Result<keyring::Entry,String>{
        r.validate()?;
        if std::env::current_exe().map_err(|_|"runtime_key_unavailable")?.file_stem().is_none_or(|n|n!="leaf"){return Err("runtime_gui_only".into());}
        keyring::Entry::new(&r.service,&r.account).map_err(|_|"runtime_key_unavailable".into())
    }
}
impl RuntimeVault for GuiRuntimeSecretStore {
    fn set(&self,r:&RuntimeCredentialRef,key:&str)->Result<(),String>{
        let entry=Self::entry(r)?;
        #[cfg(target_os="macos")] create_mac_gui_only_entry(r,key)?;
        entry.set_password(key).map_err(|_|"runtime_key_unavailable".to_string())?;runtime_cache().lock().unwrap().insert(format!("{}:{}",r.service,r.account),key.into());Ok(())
    }
    fn get(&self,r:&RuntimeCredentialRef)->Result<String,String>{r.validate()?;let id=format!("{}:{}",r.service,r.account);if let Some(key)=runtime_cache().lock().unwrap().get(&id).cloned(){return Ok(key);}let key=Self::entry(r)?.get_password().map_err(|_|"runtime_key_unavailable".to_string())?;runtime_cache().lock().unwrap().insert(id,key.clone());Ok(key)}
    fn delete(&self,r:&RuntimeCredentialRef)->Result<(),String>{runtime_cache().lock().unwrap().remove(&format!("{}:{}",r.service,r.account));match Self::entry(r)?.delete_credential(){Ok(())|Err(keyring::Error::NoEntry)=>Ok(()),Err(_)=>Err("runtime_key_unavailable".into())}}
}
impl AiClientProfile {
    pub fn masked(&self)->serde_json::Value {let mut value=serde_json::to_value(self).unwrap();value.as_object_mut().unwrap().remove("runtime_ref");value.as_object_mut().unwrap().remove("runtime_pending");value}
}
#[derive(Default)]
pub struct AiClientProfileStore {
    profiles: Vec<AiClientProfile>,
    operations: HashMap<String, String>,
    path: Option<PathBuf>,
    namespace: String,
    tunnel_cleanup:Vec<TunnelCleanup>,
    tunnel_cleanup_errors:Vec<String>,
    #[cfg(feature="native-smoke")] pub(crate) test_cleanup_failure:Option<String>,
}
#[derive(Default)]
struct TunnelCleanup {credential:Option<CredentialRef>,runtime:Option<RuntimeCredentialRef>,profile:Option<PathBuf>,health:Option<PathBuf>}
pub fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "entropy_unavailable")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
impl AiClientProfileStore {
    pub fn new(namespace: String, path: Option<PathBuf>) -> Result<Self, String> {
        if !namespace.starts_with("studio.leaf.") { return Err("invalid_namespace".into()); }
        let mut store = Self { namespace, path, ..Default::default() };
        store.profiles = CLIENTS.iter().map(|client| AiClientProfile { client: (*client).into(), configured: false, enabled: false, generation: 0, credential_ref: None,tunnel:None,has_runtime_key:false,runtime_ref:None,runtime_pending:false }).collect();
        if let Some(path) = &store.path {
            if path.exists() {
                let saved: Vec<AiClientProfile> = serde_json::from_slice(&std::fs::read(path).map_err(|_| "profile_read")?).map_err(|_| "profile_invalid")?;
                if saved.len() != 3 { return Err("profile_invalid".into()); }
                for (profile, old) in store.profiles.iter_mut().zip(saved) {
                    if profile.client != old.client || old.credential_ref.as_ref().is_some_and(|r| r.service != store.namespace || !r.account.starts_with(&format!("{}-", profile.client))) { return Err("profile_invalid".into()); }
                    if old.runtime_ref.as_ref().is_some_and(|r|r.validate().is_err()||r.service!=format!("{}.chatgpt-runtime",store.namespace.trim_end_matches(".mcp"))){return Err("profile_invalid".into());}
                    if let Some(t)=&old.tunnel {
                        let owned=path.parent().ok_or("profile_invalid")?.join("mcp/tunnel");
                        if old.client!="chatgpt"||t.profile.parent()!=Some(owned.as_path())||t.health_file.parent()!=Some(owned.as_path()){return Err("profile_invalid".into());}
                    }
                    *profile = old; profile.enabled = false; profile.generation += 1;
                    if let Some(t)=profile.tunnel.as_mut(){t.generation=profile.generation;}
                }
            }
        }
        Ok(store)
    }
    pub fn list(&self) -> Vec<AiClientProfile> { self.profiles.clone() }
    pub fn tunnel_cleanup_errors(&self)->Vec<String>{self.tunnel_cleanup_errors.clone()}
    pub(crate) fn retry_tunnel_cleanup(&mut self,shared:&dyn SecretStore,runtime:&dyn RuntimeVault){
        let pending=std::mem::take(&mut self.tunnel_cleanup);self.tunnel_cleanup_errors.clear();
        for mut item in pending {
            if let Some(reference)=&item.credential {
                if self.cleanup_allowed("credential_cleanup_failed")&&shared.delete(reference).is_ok(){item.credential=None;}else{self.tunnel_cleanup_errors.push("credential_cleanup_failed".into());}
            }
            if let Some(reference)=&item.runtime {
                if self.cleanup_allowed("runtime_cleanup_failed")&&runtime.delete(reference).is_ok(){item.runtime=None;}else{self.tunnel_cleanup_errors.push("runtime_cleanup_failed".into());}
            }
            for (path,category) in [(&mut item.profile,"profile_cleanup_failed"),(&mut item.health,"health_cleanup_failed")] {
                if let Some(old)=path.as_ref(){
                    let removed=self.cleanup_allowed(category)&&match std::fs::remove_file(old){Ok(())=>true,Err(e)=>e.kind()==std::io::ErrorKind::NotFound};
                    if removed{*path=None;}else{self.tunnel_cleanup_errors.push(category.into());}
                }
            }
            if item.credential.is_some()||item.runtime.is_some()||item.profile.is_some()||item.health.is_some(){self.tunnel_cleanup.push(item);}
        }
    }
    fn cleanup_allowed(&self,_category:&str)->bool {
        #[cfg(feature="native-smoke")] if self.test_cleanup_failure.as_deref()==Some(_category){return false;}
        true
    }
    pub fn status(&self, client: &str) -> Result<AiClientProfile, String> {
        self.profiles.iter().find(|p| p.client == client).cloned().ok_or("unknown_client".into())
    }
    pub fn token(&self, client: &str, secrets: &dyn SecretStore) -> Result<String, String> {
        let p = self.status(client)?;
        if !p.enabled { return Err("client_disabled".into()); }
        let value=secrets.get(p.credential_ref.as_ref().ok_or("client_unconfigured")?)?;
        Ok(serde_json::from_str::<BoundCredential>(&value).map(|bound|bound.token).unwrap_or(value))
    }
    fn persist(&self) -> Result<(), String> {
        if let Some(path) = &self.path {
            let parent = path.parent().ok_or("profile_path")?;
            std::fs::create_dir_all(parent).map_err(|_| "profile_write")?;
            let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| "profile_write")?;
            file.write_all(&serde_json::to_vec(&self.profiles).map_err(|_| "profile_encoding")?).map_err(|_| "profile_write")?;
            file.as_file().sync_all().map_err(|_| "profile_write")?;
            crate::atomic_file::persist(file,path).map_err(|_| "profile_write")?;
        }
        Ok(())
    }
    fn operation(&self, client: &str, operation: &str, payload: &str) -> Result<(String, String, bool), String> {
        self.status(client)?;
        if operation.is_empty() || operation.len() > 128 { return Err("invalid_operation_id".into()); }
        let key = format!("{client}:{operation}");
        let hash = format!("{:x}", Sha256::digest(payload));
        if self.operations.get(&key).is_some_and(|old| old != &hash) { return Err("operation_id_conflict".into()); }
        let repeated = self.operations.contains_key(&key);
        Ok((key, hash, repeated))
    }
    pub fn validate_configure(&self,client:&str,secret:&str,operation:&str,expected:u64)->Result<bool,String> {
        if secret.is_empty()||secret.len()>16384 {return Err("invalid_credential".into());}
        let (_,_,repeated)=self.operation(client,operation,&format!("configure:{secret}"))?;
        if !repeated&&self.status(client)?.generation!=expected {return Err("stale_configuration".into());}Ok(repeated)
    }
    pub fn validate_revoke(&self,client:&str,clear:bool,operation:&str)->Result<(),String> {self.operation(client,operation,if clear{"clear"}else{"disable"})?;Ok(())}
    pub fn configure(&mut self, client: &str, secret: &str, operation: &str, expected: u64, secrets: &dyn SecretStore) -> Result<AiClientProfile, String> {
        if secret.is_empty() || secret.len() > 16384 { return Err("invalid_credential".into()); }
        let (key, hash, repeated) = self.operation(client, operation, &format!("configure:{secret}"))?;
        if repeated { return self.status(client); }
        let old = self.status(client)?;
        if old.generation != expected { return Err("stale_configuration".into()); }
        let reference = CredentialRef { service: self.namespace.clone(), account: format!("{client}-{}", random_token()?) };
        let payload=BoundCredential{token:random_token()?,uri:String::new(),instance:String::new(),generation:old.generation+1,external_secret:None};
        secrets.set(&reference,&serde_json::to_string(&payload).map_err(|_|"credential_encoding")?)?;
        let index = self.profiles.iter().position(|p| p.client == client).unwrap();
        self.profiles[index] = AiClientProfile { configured: true, enabled: false, generation: old.generation + 1, credential_ref: Some(reference.clone()), ..old.clone() };
        if let Err(error) = self.persist() { self.profiles[index] = old; let _ = secrets.delete(&reference); return Err(error); }
        if let Some(old_ref) = old.credential_ref { secrets.delete(&old_ref)?; }
        self.operations.insert(key, hash);
        self.status(client)
    }
    pub fn enable(&mut self, client: &str, operation: &str, expected: u64, secrets: &dyn SecretStore) -> Result<AiClientProfile, String> {
        let (key, hash, repeated) = self.operation(client, operation, "enable")?;
        if repeated { return self.status(client); }
        let old = self.status(client)?;
        if old.generation != expected { return Err("stale_configuration".into()); }
        let previous=secrets.get(old.credential_ref.as_ref().ok_or("client_unconfigured")?)?;
        if old.enabled {self.operations.insert(key,hash);return Ok(old);}
        // A disabled bearer can never become valid again after re-enabling.
        let reference=CredentialRef {service:self.namespace.clone(),account:format!("{client}-{}",random_token()?)};
        let previous:BoundCredential=serde_json::from_str(&previous).map_err(|_|"credential_invalid")?;
        if previous.external_secret.is_some(){return Err("runtime_key_migration_required".into());}
        let payload=BoundCredential{token:random_token()?,uri:String::new(),instance:String::new(),generation:old.generation+1,external_secret:None};
        secrets.set(&reference,&serde_json::to_string(&payload).map_err(|_|"credential_encoding")?)?;
        let p = self.profiles.iter_mut().find(|p| p.client == client).unwrap();
        p.enabled = true; p.generation += 1; p.credential_ref=Some(reference.clone());
        if let Some(t)=p.tunnel.as_mut(){t.generation=p.generation;}
        if let Err(error) = self.persist() { *self.profiles.iter_mut().find(|p| p.client == client).unwrap() = old;let _=secrets.delete(&reference);return Err(error); }
        secrets.delete(old.credential_ref.as_ref().unwrap())?;
        self.operations.insert(key, hash); self.status(client)
    }
    // Revocation is fail-closed even if persistence or the keyring is unavailable.
    pub fn revoke(&mut self, client: &str, clear: bool, operation: &str, secrets: &dyn SecretStore) -> Result<AiClientProfile, String> {
        let (key, hash, repeated) = self.operation(client, operation, if clear { "clear" } else { "disable" })?;
        if repeated { return self.status(client); }
        let p = self.profiles.iter_mut().find(|p| p.client == client).unwrap();
        if p.enabled || (clear && p.configured) { p.generation += 1; }
        if let Some(t)=p.tunnel.as_mut(){t.generation=p.generation;}
        p.enabled = false;
        if clear {
            if let Some(reference) = &p.credential_ref { secrets.delete(reference)?; }
            p.credential_ref = None; p.configured = false;
        }
        self.persist()?;
        self.operations.insert(key, hash); self.status(client)
    }
    pub(crate) fn configure_tunnel(&mut self,mut config:TunnelProfile,key:&str,operation:&str,expected:u64,shared:&dyn SecretStore,runtime:&dyn RuntimeVault)->Result<AiClientProfile,String>{
        let old=self.status("chatgpt")?;
        let payload=format!("tunnel:{}:{}:{}",config.tunnel_id,config.executable.display(),key);
        let (op,hash,repeated)=self.operation("chatgpt",operation,&payload)?;
        if repeated{return Ok(old);}if old.generation!=expected{return Err("stale_configuration".into());}
        let key=key.trim();if key.len()>16384||key.chars().any(char::is_whitespace){return Err("invalid_runtime_key".into());}
        let fresh=!key.is_empty();
        let r=if fresh {RuntimeCredentialRef{service:format!("{}.chatgpt-runtime",self.namespace.trim_end_matches(".mcp")),account:format!("runtime-{}",random_token()?)}}else{old.runtime_ref.clone().filter(|_|!old.runtime_pending).ok_or("runtime_key_required")?};
        if fresh {runtime.set(&r,key)?;if runtime.get(&r).as_deref()!=Ok(key){let _=runtime.delete(&r);return Err("runtime_key_unavailable".into());}}else{runtime.get(&r)?;}
        let bearer=CredentialRef{service:self.namespace.clone(),account:format!("chatgpt-{}",random_token()?)};
        let generation=old.generation+1;config.generation=generation;
        let bound=BoundCredential{token:random_token()?,uri:String::new(),instance:String::new(),generation,external_secret:None};
        if let Err(e)=shared.set(&bearer,&serde_json::to_string(&bound).unwrap()){if fresh{let _=runtime.delete(&r);}return Err(e);}
        let index=self.profiles.iter().position(|p|p.client=="chatgpt").unwrap();
        self.profiles[index]=AiClientProfile{configured:true,enabled:false,generation,credential_ref:Some(bearer.clone()),tunnel:Some(config),has_runtime_key:true,runtime_ref:Some(r.clone()),runtime_pending:false,..old.clone()};
        if let Err(e)=self.persist(){self.profiles[index]=old;let _=shared.delete(&bearer);if fresh{let _=runtime.delete(&r);}return Err(e);}
        // Persistence is the commit point. Obsolete entries cannot turn a
        // committed replacement into a failed transaction or disposable YAML.
        self.operations.insert(op,hash);
        let active=self.profiles[index].tunnel.as_ref().unwrap();
        self.tunnel_cleanup.push(TunnelCleanup{credential:old.credential_ref,runtime:if fresh{old.runtime_ref}else{None},profile:old.tunnel.as_ref().filter(|p|p.profile!=active.profile).map(|p|p.profile.clone()),health:old.tunnel.as_ref().filter(|p|p.health_file!=active.health_file).map(|p|p.health_file.clone())});
        self.retry_tunnel_cleanup(shared,runtime);
        self.status("chatgpt")
    }
    pub(crate) fn validate_tunnel_operation(&self,id:&str,executable:&std::path::Path,key:&str,operation:&str,expected:u64)->Result<bool,String>{
        let (_,_,repeated)=self.operation("chatgpt",operation,&format!("tunnel:{id}:{}:{key}",executable.display()))?;
        if !repeated&&self.status("chatgpt")?.generation!=expected{return Err("stale_configuration".into());}Ok(repeated)
    }
    pub(crate) fn migrate_runtime(&mut self,shared:&dyn SecretStore,runtime:&dyn RuntimeVault)->Result<(),String>{
        let old=self.status("chatgpt")?;
        if old.runtime_ref.is_some()&&!old.runtime_pending{return Ok(());}
        let Some(shared_ref)=old.credential_ref.clone() else{return Ok(());};
        let mut bound:BoundCredential=serde_json::from_str(&shared.get(&shared_ref)?).map_err(|_|"runtime_key_migration_required")?;
        let index=self.profiles.iter().position(|p|p.client=="chatgpt").unwrap();
        if bound.external_secret.is_none()&&!old.runtime_pending{return Ok(());}
        if old.runtime_ref.is_none(){
            let key=bound.external_secret.as_deref().ok_or("runtime_key_migration_required")?;
            let r=RuntimeCredentialRef{service:format!("{}.chatgpt-runtime",self.namespace.trim_end_matches(".mcp")),account:format!("runtime-{}",random_token()?)};
            runtime.set(&r,key).map_err(|_|"runtime_key_migration_required")?;
            if runtime.get(&r).as_deref()!=Ok(key){let _=runtime.delete(&r);return Err("runtime_key_migration_required".into());}
            self.profiles[index].runtime_ref=Some(r.clone());self.profiles[index].has_runtime_key=true;self.profiles[index].runtime_pending=true;
            if self.persist().is_err(){self.profiles[index]=old;let _=runtime.delete(&r);return Err("runtime_key_migration_required".into());}
        }
        runtime.get(self.profiles[index].runtime_ref.as_ref().unwrap()).map_err(|_|"runtime_key_migration_required")?;
        bound.external_secret=None;
        shared.set(&shared_ref,&serde_json::to_string(&bound).unwrap()).map_err(|_|"runtime_key_migration_required")?;
        self.profiles[index].runtime_pending=false;
        if self.persist().is_err(){self.profiles[index].runtime_pending=true;return Err("runtime_key_migration_required".into());}Ok(())
    }
    pub(crate) fn runtime_key(&mut self,shared:&dyn SecretStore,runtime:&dyn RuntimeVault)->Result<String,String>{
        self.migrate_runtime(shared,runtime)?;let p=self.status("chatgpt")?;
        if p.runtime_pending{return Err("runtime_key_migration_required".into());}
        runtime.get(p.runtime_ref.as_ref().ok_or("runtime_key_required")?)
    }
    pub(crate) fn clear_runtime(&mut self,runtime:&dyn RuntimeVault)->Result<(),String>{
        let index=self.profiles.iter().position(|p|p.client=="chatgpt").unwrap();let old=self.profiles[index].clone();
        self.profiles[index].tunnel=None;self.profiles[index].has_runtime_key=false;self.profiles[index].runtime_ref=None;self.profiles[index].runtime_pending=false;
        if let Err(e)=self.persist(){self.profiles[index]=old;return Err(e);}
        if let Some(r)=old.runtime_ref{runtime.delete(&r)?;}
        if let Some(previous)=old.tunnel {for path in [previous.profile,previous.health_file]{match std::fs::remove_file(path){Ok(())=>{},Err(e)if e.kind()==std::io::ErrorKind::NotFound=>{},Err(_)=>return Err("tunnel_profile_cleanup_failed".into())}}}Ok(())
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::Mutex;
    #[derive(Default)]
    struct MemoryKeyring(Mutex<HashMap<String, String>>);
    impl SecretStore for MemoryKeyring {
        fn set(&self,r:&CredentialRef,s:&str)->Result<(),String>{self.0.lock().unwrap().insert(r.account.clone(),s.into());Ok(())}
        fn get(&self,r:&CredentialRef)->Result<String,String>{self.0.lock().unwrap().get(&r.account).cloned().ok_or("credential_unavailable".into())}
        fn delete(&self,r:&CredentialRef)->Result<(),String>{self.0.lock().unwrap().remove(&r.account);Ok(())}
    }
    fn store()->AiClientProfileStore {AiClientProfileStore::new("studio.leaf.synthetic.mcp".into(),None).unwrap()}
    #[test]
    fn runtime_key_is_not_helper_payload() {
        let mut s=store();let k=MemoryKeyring::default();
        let p=s.configure("chatgpt","synthetic-runtime-sentinel","runtime-red",0,&k).unwrap();
        let bound:BoundCredential=serde_json::from_str(&k.get(p.credential_ref.as_ref().unwrap()).unwrap()).unwrap();
        assert!(bound.external_secret.is_none(),"helper-readable payload must not contain the runtime key");
    }
    #[derive(Default)]
    struct MemoryRuntime(Mutex<HashMap<String,String>>);
    impl RuntimeVault for MemoryRuntime {
        fn set(&self,r:&RuntimeCredentialRef,key:&str)->Result<(),String>{r.validate()?;self.0.lock().unwrap().insert(r.account.clone(),key.into());Ok(())}
        fn get(&self,r:&RuntimeCredentialRef)->Result<String,String>{r.validate()?;self.0.lock().unwrap().get(&r.account).cloned().ok_or("runtime_key_unavailable".into())}
        fn delete(&self,r:&RuntimeCredentialRef)->Result<(),String>{self.0.lock().unwrap().remove(&r.account);Ok(())}
    }
    fn config()->TunnelProfile {TunnelProfile{tunnel_id:format!("tunnel_{}","a".repeat(32)),executable:"/synthetic/tunnel-client".into(),profile:"/synthetic/leaf.yaml".into(),health_file:"/synthetic/leaf.health".into(),generation:0,digest:"synthetic-digest".into()}}
    #[test]
    fn tunnel_blank_replacement_retains_gui_key_and_masks_reference(){
        let mut s=store();let shared=MemoryKeyring::default();let runtime=MemoryRuntime::default();
        s.configure("workbuddy","local","buddy",0,&shared).unwrap();let buddy=s.status("workbuddy").unwrap();
        assert!(s.configure_tunnel(config(),"","empty",0,&shared,&runtime).is_err());
        let p=s.configure_tunnel(config(),"synthetic-runtime-sentinel","save",0,&shared,&runtime).unwrap();
        assert_eq!(s.configure_tunnel(config(),"synthetic-runtime-sentinel","save",0,&shared,&runtime).unwrap(),p);
        assert!(s.validate_tunnel_operation(&p.tunnel.as_ref().unwrap().tunnel_id,&p.tunnel.as_ref().unwrap().executable,"synthetic-runtime-sentinel","save",0).unwrap());
        assert!(s.validate_tunnel_operation(&p.tunnel.as_ref().unwrap().tunnel_id,&p.tunnel.as_ref().unwrap().executable,"different-key","save",p.generation).is_err());
        let original=p.runtime_ref.clone().unwrap();let next=s.configure_tunnel(config(),"   ","replace",p.generation,&shared,&runtime).unwrap();
        assert_eq!(next.runtime_ref,Some(original.clone()));assert_eq!(runtime.get(&original).unwrap(),"synthetic-runtime-sentinel");
        assert_eq!(s.status("workbuddy").unwrap(),buddy);
        let exported=next.masked().to_string();assert!(!exported.contains("runtime-sentinel")&&!exported.contains("runtime_ref")&&!exported.contains("chatgpt-runtime"));assert!(next.has_runtime_key);
        let forged=CredentialRef{service:original.service.clone(),account:original.account.clone()};assert!(forged.load().is_err());
        let descriptor=BrokerDescriptor{uri:"http://127.0.0.1:1234/mcp".into(),client:"chatgpt".into(),generation:next.generation,instance:"a".repeat(64),credential_file:None,credential_ref:forged};assert!(descriptor.load_token().is_err());
        assert!(shared.0.lock().unwrap().values().all(|v|!v.contains("runtime-sentinel")));
        s.clear_runtime(&runtime).unwrap();assert!(runtime.0.lock().unwrap().is_empty());assert_eq!(s.status("workbuddy").unwrap(),buddy);
    }
    #[test]
    fn tunnel_persistence_failure_rolls_back_both_new_entries(){
        let mut s=store();let shared=MemoryKeyring::default();let runtime=MemoryRuntime::default();let before=s.list();
        let dir=tempfile::tempdir().unwrap();s.path=Some(dir.path().into());
        assert!(s.configure_tunnel(config(),"synthetic-runtime-sentinel","save",0,&shared,&runtime).is_err());
        assert_eq!(s.list(),before);assert!(shared.0.lock().unwrap().is_empty());assert!(runtime.0.lock().unwrap().is_empty());
    }
    #[test]
    fn committed_tunnel_replacement_survives_each_obsolete_cleanup_failure(){
        struct SharedGate<'a>{inner:&'a MemoryKeyring,denied:Mutex<Option<String>>}
        impl SecretStore for SharedGate<'_>{
            fn set(&self,r:&CredentialRef,s:&str)->Result<(),String>{self.inner.set(r,s)}
            fn get(&self,r:&CredentialRef)->Result<String,String>{self.inner.get(r)}
            fn delete(&self,r:&CredentialRef)->Result<(),String>{if self.denied.lock().unwrap().as_deref()==Some(&r.account){Err("denied".into())}else{self.inner.delete(r)}}
        }
        struct RuntimeGate<'a>{inner:&'a MemoryRuntime,denied:Mutex<Option<String>>}
        impl RuntimeVault for RuntimeGate<'_>{
            fn set(&self,r:&RuntimeCredentialRef,s:&str)->Result<(),String>{self.inner.set(r,s)}
            fn get(&self,r:&RuntimeCredentialRef)->Result<String,String>{self.inner.get(r)}
            fn delete(&self,r:&RuntimeCredentialRef)->Result<(),String>{if self.denied.lock().unwrap().as_deref()==Some(&r.account){Err("denied".into())}else{self.inner.delete(r)}}
        }
        for category in ["credential_cleanup_failed","runtime_cleanup_failed","profile_cleanup_failed","health_cleanup_failed"] {
            let directory=tempfile::tempdir().unwrap();let path=directory.path().join("profiles.json");let folder=directory.path().join("mcp/tunnel");std::fs::create_dir_all(&folder).unwrap();
            let mut s=AiClientProfileStore::new("studio.leaf.synthetic.mcp".into(),Some(path.clone())).unwrap();
            let shared=MemoryKeyring::default();let runtime=MemoryRuntime::default();
            let shared=SharedGate{inner:&shared,denied:Mutex::new(None)};let runtime=RuntimeGate{inner:&runtime,denied:Mutex::new(None)};
            let mut original=config();original.profile=folder.join("old.yaml");original.health_file=folder.join("old.health");
            std::fs::write(&original.profile,"synthetic old").unwrap();std::fs::write(&original.health_file,"synthetic old health").unwrap();
            let old=s.configure_tunnel(original.clone(),"synthetic-old-key","old",0,&shared,&runtime).unwrap();
            match category {
                "credential_cleanup_failed"=>*shared.denied.lock().unwrap()=Some(old.credential_ref.as_ref().unwrap().account.clone()),
                "runtime_cleanup_failed"=>*runtime.denied.lock().unwrap()=Some(old.runtime_ref.as_ref().unwrap().account.clone()),
                _=>{let file=if category=="profile_cleanup_failed"{&original.profile}else{&original.health_file};std::fs::remove_file(file).unwrap();std::fs::create_dir(file).unwrap();}
            }
            let mut replacement=config();replacement.profile=folder.join("new.yaml");replacement.health_file=folder.join("new.health");std::fs::write(&replacement.profile,"synthetic replacement").unwrap();
            let active=s.configure_tunnel(replacement.clone(),"synthetic-new-key","replace",old.generation,&shared,&runtime).unwrap();
            assert_eq!(s.tunnel_cleanup_errors(),vec![category]);assert_eq!(s.status("chatgpt").unwrap(),active);
            let saved:Vec<AiClientProfile>=serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();assert_eq!(saved[0],active);
            assert_eq!(active.tunnel.as_ref().unwrap().generation,active.generation);assert!(replacement.profile.is_file());
            let bound:BoundCredential=serde_json::from_str(&shared.get(active.credential_ref.as_ref().unwrap()).unwrap()).unwrap();assert_eq!(bound.generation,active.generation);
            assert_eq!(runtime.get(active.runtime_ref.as_ref().unwrap()).unwrap(),"synthetic-new-key");
            assert_eq!(s.configure_tunnel(replacement.clone(),"synthetic-new-key","replace",old.generation,&shared,&runtime).unwrap(),active,"committed retry does not create another generation");
            *shared.denied.lock().unwrap()=None;*runtime.denied.lock().unwrap()=None;
            for file in [&original.profile,&original.health_file]{if file.is_dir(){std::fs::remove_dir(file).unwrap();}}
            s.retry_tunnel_cleanup(&shared,&runtime);assert!(s.tunnel_cleanup_errors().is_empty());assert!(replacement.profile.is_file());assert_eq!(s.status("chatgpt").unwrap(),active);
        }
    }
    #[test]
    fn legacy_migration_preserves_bearer_and_retries_pending_removal(){
        use std::sync::atomic::{AtomicBool,Ordering};
        struct RemovalGate<'a>{shared:&'a MemoryKeyring,denied:AtomicBool}
        impl SecretStore for RemovalGate<'_>{
            fn set(&self,r:&CredentialRef,s:&str)->Result<(),String>{if self.denied.load(Ordering::SeqCst){Err("credential_unavailable".into())}else{self.shared.set(r,s)}}
            fn get(&self,r:&CredentialRef)->Result<String,String>{self.shared.get(r)}
            fn delete(&self,r:&CredentialRef)->Result<(),String>{self.shared.delete(r)}
        }
        let mut s=store();let shared=MemoryKeyring::default();let runtime=MemoryRuntime::default();
        let p=s.configure("chatgpt","broker-only","old",0,&shared).unwrap();let r=p.credential_ref.unwrap();
        let mut old:BoundCredential=serde_json::from_str(&shared.get(&r).unwrap()).unwrap();old.uri="http://127.0.0.1:1234/mcp".into();old.instance="a".repeat(64);old.external_secret=Some("synthetic-legacy-sentinel".into());shared.set(&r,&serde_json::to_string(&old).unwrap()).unwrap();
        let gate=RemovalGate{shared:&shared,denied:AtomicBool::new(true)};
        assert_eq!(s.migrate_runtime(&gate,&runtime),Err("runtime_key_migration_required".into()));assert!(s.status("chatgpt").unwrap().runtime_pending);
        assert!(s.runtime_key(&gate,&runtime).is_err());assert_eq!(runtime.0.lock().unwrap().len(),1);
        gate.denied.store(false,Ordering::SeqCst);assert_eq!(s.runtime_key(&gate,&runtime).unwrap(),"synthetic-legacy-sentinel");
        let migrated:BoundCredential=serde_json::from_str(&shared.get(&r).unwrap()).unwrap();assert!(migrated.external_secret.is_none());assert_eq!((migrated.token,migrated.uri,migrated.instance,migrated.generation),(old.token,old.uri,old.instance,old.generation));assert!(!s.status("chatgpt").unwrap().runtime_pending);
    }
    #[test]
    fn legacy_gui_write_failure_keeps_shared_payload_unchanged(){
        struct Denied;impl RuntimeVault for Denied{fn set(&self,_:&RuntimeCredentialRef,_:&str)->Result<(),String>{Err("denied".into())}fn get(&self,_:&RuntimeCredentialRef)->Result<String,String>{Err("denied".into())}fn delete(&self,_:&RuntimeCredentialRef)->Result<(),String>{Ok(())}}
        let mut s=store();let shared=MemoryKeyring::default();let p=s.configure("chatgpt","broker-only","old",0,&shared).unwrap();let r=p.credential_ref.clone().unwrap();
        let mut old:BoundCredential=serde_json::from_str(&shared.get(&r).unwrap()).unwrap();old.external_secret=Some("synthetic-legacy-sentinel".into());let payload=serde_json::to_string(&old).unwrap();shared.set(&r,&payload).unwrap();
        assert_eq!(s.migrate_runtime(&shared,&Denied),Err("runtime_key_migration_required".into()));assert_eq!(s.status("chatgpt").unwrap(),p);assert_eq!(shared.get(&r).unwrap(),payload);
    }
    #[test]
    fn identity_order_and_empty_input_are_explicit() {
        let mut s=store();let k=MemoryKeyring::default();
        assert_eq!(s.list().iter().map(|p|p.client.as_str()).collect::<Vec<_>>(),CLIENTS);
        assert!(s.list().iter().all(|p|!p.enabled&&!p.configured));
        for client in ["", "ChatGPT", "codex", "claude", "workbuddy "] {assert!(s.configure(client,"synthetic","save",0,&k).is_err());}
        assert!(s.configure("chatgpt","","save",0,&k).is_err());
        assert!(s.enable("chatgpt","enable",0,&k).is_err());assert!(k.0.lock().unwrap().is_empty());
    }
    #[test]
    fn independent_clear_preserves_other_clients_and_hides_secrets() {
        let mut s=store();let k=MemoryKeyring::default();
        for c in CLIENTS {let p=s.configure(c,"synthetic-secret","save",0,&k).unwrap();s.enable(c,"enable",p.generation,&k).unwrap();}
        let before=s.status("workbuddy").unwrap();let reference=s.status("chatgpt").unwrap().credential_ref.unwrap();
        s.revoke("chatgpt",true,"clear",&k).unwrap();assert!(k.get(&reference).is_err());
        assert_eq!(s.status("workbuddy").unwrap(),before);assert_eq!(s.token("workbuddy",&k).unwrap().len(),64);
        let exported=serde_json::to_string(&s.list()).unwrap();assert!(!exported.contains("synthetic-secret"));
        assert_eq!(k.0.lock().unwrap().len(),2);
    }
    #[test]
    fn retries_conflicts_and_stale_configuration_cannot_revive_access() {
        let mut s=store();let k=MemoryKeyring::default();
        let p=s.configure("chatgpt","synthetic","save",0,&k).unwrap();
        assert_eq!(s.configure("chatgpt","synthetic","save",0,&k).unwrap(),p);
        assert!(s.configure("chatgpt","changed","save",p.generation,&k).is_err());
        assert!(s.enable("chatgpt","wrong-generation",0,&k).is_err());
        s.enable("chatgpt","enable",p.generation,&k).unwrap();let disabled=s.revoke("chatgpt",false,"disable",&k).unwrap();
        assert_eq!(s.revoke("chatgpt",false,"disable",&k).unwrap(),disabled);
        assert!(!s.enable("chatgpt","enable",p.generation,&k).unwrap().enabled);
        assert!(s.token("chatgpt",&k).is_err());
        let old_ref=disabled.credential_ref.unwrap();let old_token=k.get(&old_ref).unwrap();
        s.enable("chatgpt","new-enable",disabled.generation,&k).unwrap();assert_ne!(s.token("chatgpt",&k).unwrap(),old_token);assert!(k.get(&old_ref).is_err());
    }
    #[test]
    fn restart_retires_client_capabilities_and_profiles_persist_without_secrets() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("profiles.json");let k=MemoryKeyring::default();
        let mut s=AiClientProfileStore::new("studio.leaf.synthetic.mcp".into(),Some(path.clone())).unwrap();
        let p=s.configure("chatgpt","synthetic-secret","save",0,&k).unwrap();s.enable("chatgpt","enable",p.generation,&k).unwrap();
        assert!(!std::fs::read_to_string(&path).unwrap().contains("synthetic-secret"));
        let restarted=AiClientProfileStore::new("studio.leaf.synthetic.mcp".into(),Some(path)).unwrap();assert!(!restarted.status("chatgpt").unwrap().enabled);
    }
    #[test]
    fn master_preference_persists_explicit_consent_and_refuses_invalid_data() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("mcp-preferences-v1.json");
        assert!(!McpPreferences::load(&path).unwrap().enabled);
        McpPreferences{enabled:true}.save(&path).unwrap();assert!(McpPreferences::load(&path).unwrap().enabled);
        McpPreferences{enabled:false}.save(&path).unwrap();assert!(!McpPreferences::load(&path).unwrap().enabled);
        assert_eq!(std::fs::read_to_string(&path).unwrap(),"{\"enabled\":false}");
        std::fs::write(&path,"{broken").unwrap();assert!(McpPreferences::load(&path).is_err());
        assert!(McpPreferences{enabled:true}.save(&dir.path().join("missing-parent/file")).is_ok());
        assert!(McpPreferences{enabled:true}.save(dir.path()).is_err());
    }
    #[test]
    fn unavailable_keyring_never_creates_plaintext_fallback() {
        struct Denied;impl SecretStore for Denied {
            fn set(&self,_:&CredentialRef,_:&str)->Result<(),String>{Err("credential_unavailable".into())}
            fn get(&self,_:&CredentialRef)->Result<String,String>{Err("credential_unavailable".into())}
            fn delete(&self,_:&CredentialRef)->Result<(),String>{Err("credential_unavailable".into())}
        }
        let mut s=store();let before=s.list();assert!(s.configure("chatgpt","synthetic","save",0,&Denied).is_err());assert_eq!(s.list(),before);
    }
    #[cfg(windows)]
    #[test]
    fn protecting_shared_app_directory_preserves_siblings_and_nested_access() {
        let dir=tempfile::tempdir().unwrap();let root=dir.path().join("app-data");
        std::fs::create_dir_all(root.join("mcp/nested")).unwrap();
        let path=root.join("mcp-profiles-v1.json");let secrets=MemoryKeyring::default();
        let mut profiles=AiClientProfileStore::new("studio.leaf.synthetic.mcp".into(),Some(path.clone())).unwrap();
        profiles.configure("workbuddy","synthetic-local-profile","save",0,&secrets).unwrap();
        std::fs::write(root.join("mcp/nested/synthetic.json"),"{}").unwrap();
        McpPreferences{enabled:true}.save(&root.join("mcp-preferences-v1.json")).unwrap();
        assert!(AiClientProfileStore::new("studio.leaf.synthetic.mcp".into(),Some(path)).unwrap().status("workbuddy").unwrap().configured);
        assert_eq!(std::fs::read_dir(root.join("mcp/nested")).unwrap().count(),1);
        write_private(&root.join("mcp/credentials/synthetic.json"),"{}").unwrap();
        private_directory(&root).unwrap();
        assert_eq!(read_private(&root.join("mcp/credentials/synthetic.json")).unwrap(),"{}");
        std::fs::remove_dir_all(&root).unwrap();
    }
}

#[cfg(test)]mod session_secret_tests {
 use super::*;
 #[test]fn session_credentials_and_helper_binding_need_no_keychain(){
  let dir=tempfile::tempdir().unwrap();let path=dir.path().join("credentials/client.json");
  let r=CredentialRef{service:"studio.leaf.synthetic.mcp".into(),account:"chatgpt-synthetic".into()};
  let bound=BoundCredential{token:"synthetic-local-bearer".into(),uri:"http://127.0.0.1:1234/mcp".into(),instance:"a".repeat(64),generation:7,external_secret:None};
  let text=serde_json::to_string(&bound).unwrap();SessionSecrets.set(&r,&text).unwrap();assert_eq!(SessionSecrets.get(&r).unwrap(),text);
  write_private(&path,&text).unwrap();let mut d=BrokerDescriptor{uri:bound.uri.clone(),client:"chatgpt".into(),generation:7,instance:bound.instance.clone(),credential_file:Some(path.clone()),credential_ref:r.clone()};
  assert_eq!(d.load_token().unwrap(),bound.token);d.generation=8;assert_eq!(d.load_token().unwrap_err(),"stale_broker_descriptor");SessionSecrets.delete(&r).unwrap();assert!(SessionSecrets.get(&r).is_err());
  #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o644)).unwrap();assert!(read_private(&path).is_err());}
 }
 #[test]fn runtime_session_cache_avoids_reopening_the_os_item(){let r=RuntimeCredentialRef{service:"studio.leaf.synthetic.chatgpt-runtime".into(),account:"runtime-synthetic-cache".into()};let id=format!("{}:{}",r.service,r.account);runtime_cache().lock().unwrap().insert(id.clone(),"synthetic-api-key".into());for _ in 0..3{assert_eq!(GuiRuntimeSecretStore.get(&r).unwrap(),"synthetic-api-key");}runtime_cache().lock().unwrap().remove(&id);}
}
