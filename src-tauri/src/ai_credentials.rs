//! The only persistent secret store is the operating system keyring.
//! Serialized profiles and descriptors contain opaque references, never secrets.
use std::{collections::HashMap, path::PathBuf, io::Write};
use serde::{Serialize, Deserialize};
use sha2::{Digest, Sha256};

pub const CLIENTS: [&str; 3] = ["chatgpt", "claude-desktop", "workbuddy"];
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CredentialRef { pub service: String, pub account: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerDescriptor {pub uri:String,pub client:String,pub generation:u64,pub instance:String,pub credential_ref:CredentialRef}
#[derive(Serialize,Deserialize)]
pub struct BoundCredential {pub token:String,pub uri:String,pub instance:String,pub generation:u64,#[serde(default)]pub external_secret:Option<String>}
impl BrokerDescriptor {
    pub fn validate(&self)->Result<(),String> {
        let port=self.uri.strip_prefix("http://127.0.0.1:").and_then(|s|s.strip_suffix("/mcp")).ok_or("invalid_broker_descriptor")?;
        if port.parse::<u16>().ok().is_none_or(|p|p==0)||!port.bytes().all(|b|b.is_ascii_digit())||!CLIENTS.contains(&self.client.as_str())||!self.credential_ref.service.starts_with("studio.leaf.")||!self.credential_ref.service.ends_with(".mcp")||!self.credential_ref.account.starts_with(&format!("{}-",self.client))||self.instance.len()!=64 {return Err("invalid_broker_descriptor".into());}Ok(())
    }
    pub fn load_token(&self)->Result<String,String> {
        self.validate()?;
        // Let the OS evaluate its exact per-entry ACL. Disabling Keychain
        // interaction globally rejects legitimate ad-hoc helpers as well.
        // The helper applies a bounded startup timeout around this OS call.
        let bound:BoundCredential=serde_json::from_str(&self.credential_ref.load()?).map_err(|_|"credential_unbound")?;
        if bound.uri!=self.uri||bound.instance!=self.instance||bound.generation!=self.generation {return Err("stale_broker_descriptor".into());}Ok(bound.token)
    }
}
impl CredentialRef {
    fn entry(&self) -> Result<keyring::Entry, String> {
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

// Keyring's macOS setter creates a caller-only ACL. For NEW Leaf entries use
// Apple's public creation API with exactly the GUI and its sibling helper.
// Existing entries keep their ACL; no login keychain or other item is changed.
#[cfg(target_os="macos")]
fn create_mac_shared_entry(reference:&CredentialRef,secret:&str)->Result<(),String> {
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
    if !helper.is_file() {return Err("helper_not_installed".into());}
    let helper=CString::new(helper.as_os_str().as_encoded_bytes()).map_err(|_|"credential_unavailable")?;
    let description=CString::new("Leaf MCP connection").unwrap();
    unsafe {
        let mut gui=ptr::null();let mut adapter=ptr::null();
        if SecTrustedApplicationCreateFromPath(ptr::null(),&mut gui)!=0 {return Err("credential_unavailable".into());}
        let gui=Owned(gui);
        if SecTrustedApplicationCreateFromPath(helper.as_ptr(),&mut adapter)!=0 {return Err("credential_unavailable".into());}
        let adapter=Owned(adapter);let values=[gui.0,adapter.0];
        let trusted=Owned(CFArrayCreate(ptr::null(),values.as_ptr(),2,ptr::null()));
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
                    if let Some(root)=std::env::var_os("LEAF_MCP_TEST_DIR") {let _=std::fs::write(PathBuf::from(root).join("acl-effective.json"),serde_json::to_vec(&evidence).unwrap());}
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
}
#[derive(Default)]
pub struct AiClientProfileStore {
    profiles: Vec<AiClientProfile>,
    operations: HashMap<String, String>,
    path: Option<PathBuf>,
    namespace: String,
}
pub fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "entropy_unavailable")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
impl AiClientProfileStore {
    pub fn new(namespace: String, path: Option<PathBuf>) -> Result<Self, String> {
        if !namespace.starts_with("studio.leaf.") { return Err("invalid_namespace".into()); }
        let mut store = Self { namespace, path, ..Default::default() };
        store.profiles = CLIENTS.iter().map(|client| AiClientProfile { client: (*client).into(), configured: false, enabled: false, generation: 0, credential_ref: None }).collect();
        if let Some(path) = &store.path {
            if path.exists() {
                let saved: Vec<AiClientProfile> = serde_json::from_slice(&std::fs::read(path).map_err(|_| "profile_read")?).map_err(|_| "profile_invalid")?;
                if saved.len() != 3 { return Err("profile_invalid".into()); }
                for (profile, old) in store.profiles.iter_mut().zip(saved) {
                    if profile.client != old.client || old.credential_ref.as_ref().is_some_and(|r| r.service != store.namespace || !r.account.starts_with(&format!("{}-", profile.client))) { return Err("profile_invalid".into()); }
                    *profile = old; profile.enabled = false; profile.generation += 1;
                }
            }
        }
        Ok(store)
    }
    pub fn list(&self) -> Vec<AiClientProfile> { self.profiles.clone() }
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
            file.persist(path).map_err(|_| "profile_write")?;
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
        let payload=BoundCredential{token:random_token()?,uri:String::new(),instance:String::new(),generation:old.generation+1,external_secret:(client=="chatgpt").then(||secret.into())};
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
        let payload=BoundCredential{token:random_token()?,uri:String::new(),instance:String::new(),generation:old.generation+1,external_secret:previous.external_secret};
        secrets.set(&reference,&serde_json::to_string(&payload).map_err(|_|"credential_encoding")?)?;
        let p = self.profiles.iter_mut().find(|p| p.client == client).unwrap();
        p.enabled = true; p.generation += 1; p.credential_ref=Some(reference.clone());
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
        p.enabled = false;
        if clear {
            if let Some(reference) = &p.credential_ref { secrets.delete(reference)?; }
            p.credential_ref = None; p.configured = false;
        }
        self.persist()?;
        self.operations.insert(key, hash); self.status(client)
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
    fn restart_is_disabled_and_profiles_persist_without_secrets() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("profiles.json");let k=MemoryKeyring::default();
        let mut s=AiClientProfileStore::new("studio.leaf.synthetic.mcp".into(),Some(path.clone())).unwrap();
        let p=s.configure("chatgpt","synthetic-secret","save",0,&k).unwrap();s.enable("chatgpt","enable",p.generation,&k).unwrap();
        assert!(!std::fs::read_to_string(&path).unwrap().contains("synthetic-secret"));
        let restarted=AiClientProfileStore::new("studio.leaf.synthetic.mcp".into(),Some(path)).unwrap();assert!(!restarted.status("chatgpt").unwrap().enabled);
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
}
