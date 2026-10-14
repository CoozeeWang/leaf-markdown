//! The only persistent secret store is the operating system keyring.
//! Serialized profiles and descriptors contain opaque references, never secrets.
use std::{collections::HashMap, path::PathBuf, io::Write};
use serde::{Serialize, Deserialize};
use sha2::{Digest, Sha256};

pub const CLIENTS: [&str; 3] = ["chatgpt", "claude-desktop", "workbuddy"];
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CredentialRef { pub service: String, pub account: String }
impl CredentialRef {
    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, &self.account).map_err(|_| "credential_unavailable".into())
    }
    pub fn load(&self) -> Result<String, String> {
        self.entry()?.get_password().map_err(|_| "credential_unavailable".into())
    }
}
pub trait SecretStore: Send + Sync {
    fn set(&self, reference: &CredentialRef, secret: &str) -> Result<(), String>;
    fn get(&self, reference: &CredentialRef) -> Result<String, String>;
    fn delete(&self, reference: &CredentialRef) -> Result<(), String>;
}
pub struct OsKeyring;
impl SecretStore for OsKeyring {
    fn set(&self, r: &CredentialRef, s: &str) -> Result<(), String> { r.entry()?.set_password(s).map_err(|_| "credential_unavailable".into()) }
    fn get(&self, r: &CredentialRef) -> Result<String, String> { r.load() }
    fn delete(&self, r: &CredentialRef) -> Result<(), String> {
        match r.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("credential_unavailable".into()),
        }
    }
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
        secrets.get(p.credential_ref.as_ref().ok_or("client_unconfigured")?)
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
        secrets.set(&reference, secret)?;
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
        secrets.get(old.credential_ref.as_ref().ok_or("client_unconfigured")?)?;
        if old.enabled {self.operations.insert(key,hash);return Ok(old);}
        // A disabled bearer can never become valid again after re-enabling.
        let reference=CredentialRef {service:self.namespace.clone(),account:format!("{client}-{}",random_token()?)};
        secrets.set(&reference,&random_token()?)?;
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
