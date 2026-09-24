use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}, sync::atomic::{AtomicU64, Ordering}};

const MAX_VERSIONS: usize = 20;
const MAX_BYTES: usize = 32 * 1024 * 1024;
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn unique_id() -> String {
    format!("{:x}-{:x}-{:x}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos(), std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed))
}
pub fn file_key(path: &Path) -> String { format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes())) }
pub fn draft_key() -> String { format!("draft-{}", unique_id()) }

#[derive(Clone, Serialize, Deserialize)]
pub struct Version {
    pub id: String,
    pub timestamp: u64,
    pub kind: String,
    pub content: String,
}
impl Version {
    fn new(content: &str, kind: &str) -> Self {
        Self { id: unique_id(), timestamp: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64, kind: kind.into(), content: content.into() }
    }
}
#[derive(Default, Serialize, Deserialize)]
pub struct Record {
    pub source: Option<String>,
    pub versions: Vec<Version>,
    pub draft: Option<Version>,
    #[serde(default)]
    pub draft_session: Option<String>,
}
#[derive(Serialize)]
pub struct Entry {
    pub key: String,
    pub id: String,
    pub timestamp: u64,
    pub kind: String,
    pub source: Option<String>,
    pub bytes: usize,
}
fn entry(key: &str, record: &Record, version: &Version) -> Entry {
    Entry { key: key.into(), id: version.id.clone(), timestamp: version.timestamp, kind: version.kind.clone(), source: record.source.clone(), bytes: version.content.len() }
}
pub struct Store { root: PathBuf }
impl Store {
    pub fn new(root: PathBuf) -> Self { Self { root } }
    fn path(&self, key: &str) -> Result<PathBuf, String> {
        if key.is_empty() || key.len() > 120 || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return Err("无效的恢复记录".into()); }
        Ok(self.root.join(format!("{key}.json")))
    }
    pub fn read(&self, key: &str) -> Result<Record, String> {
        match fs::read(self.path(key)?) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("恢复记录损坏，原记录已保留：{e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Record::default()),
            Err(e) => Err(e.to_string()),
        }
    }
    fn write(&self, key: &str, record: &Record) -> Result<(), String> {
        let path = self.path(key)?;
        fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.root, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        }
        let mut temp = tempfile::NamedTempFile::new_in(&self.root).map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut temp, record).map_err(|e| e.to_string())?;
        temp.flush().map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist(path).map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn copy_for_rename(&self, old: &str, new: &str, source: &str) -> Result<(), String> {
        let mut record=self.read(old)?;
        let existing=self.read(new)?;
        record.versions.extend(existing.versions);
        record.versions.sort_by(|a,b|b.timestamp.cmp(&a.timestamp));
        record.versions.dedup_by(|a,b|a.id==b.id);
        record.versions.truncate(MAX_VERSIONS);
        record.source=Some(source.into());
        self.write(new,&record)
    }
    pub fn checkpoint(&self, key: &str, source: Option<String>, content: &str, owner: &str, preserve: bool) -> Result<(), String> {
        if content.len() > MAX_BYTES { return Err("文档超过 32 MB，无法建立恢复草稿；请手动保存。".into()); }
        let mut record = self.read(key)?;
        if !preserve && record.draft_session.as_deref() == Some(owner) && record.draft.as_ref().is_some_and(|v| v.content == content) { return Ok(()); }
        // Preserve the previous checkpoint as a version before replacing it.
        // Opening a file never calls this; an edit cannot erase a crashed session.
        if record.draft_session.as_deref() != Some(owner) {
            if let Some(previous) = record.draft.take() { record.versions.insert(0, previous); }
        }
        if preserve && record.versions.first().is_none_or(|v| v.content != content) {
            record.versions.insert(0, Version::new(content, "draft"));
        }
        record.draft_session = Some(owner.into());
        record.versions.truncate(MAX_VERSIONS);
        record.source = source;
        record.draft = Some(Version::new(content, "draft"));
        self.write(key, &record)
    }
    pub fn before_save(&self, key: &str, source: String, content: Option<&str>) -> Result<(), String> {
        let mut record = self.read(key)?;
        record.source = Some(source);
        if let Some(content) = content {
            if content.len() > MAX_BYTES { return Err("旧版本超过 32 MB，无法安全建立历史版本。".into()); }
            if record.versions.first().is_none_or(|v| v.content != content) {
                record.versions.insert(0, Version::new(content, "saved"));
                record.versions.truncate(MAX_VERSIONS);
            }
        }
        self.write(key, &record)
    }
    pub fn saved(&self, key: &str, content: &str) -> Result<(), String> {
        let mut record = self.read(key)?;
        if record.draft.as_ref().is_some_and(|v| v.content == content) {
            record.draft = None;
            self.write(key, &record)?;
        }
        Ok(())
    }
    pub fn list(&self, key: &str) -> Result<Vec<Entry>, String> {
        let record = self.read(key)?;
        Ok(record.draft.iter().chain(record.versions.iter()).map(|v| entry(key, &record, v)).collect())
    }
    pub fn drafts(&self) -> Result<Vec<Entry>, String> {
        let files = match fs::read_dir(&self.root) { Ok(files) => files, Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]), Err(e) => return Err(e.to_string()) };
        let mut entries = vec![];
        for file in files {
            let path = file.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|v| v.to_str()) != Some("json") { continue; }
            let key = path.file_stem().and_then(|v| v.to_str()).ok_or("无效恢复文件名")?;
            let record = self.read(key)?;
            if let Some(ref version) = record.draft { entries.push(entry(key, &record, version)); }
        }
        entries.sort_by(|a,b| b.timestamp.cmp(&a.timestamp));
        Ok(entries)
    }
    pub fn content(&self, key: &str, id: &str) -> Result<String, String> {
        let record = self.read(key)?;
        record.draft.iter().chain(record.versions.iter()).find(|v| v.id == id).map(|v| v.content.clone()).ok_or("版本已清理，请刷新列表".into())
    }
    // Expiry uses the timestamp inside each record, never the file mtime.
    // Open-document drafts and unreadable records are retained.
    pub fn expire(&self, days: u32, now: u64, active: &[String]) -> Result<usize, String> {
        if ![7,30,90].contains(&days) { return Err("恢复记录保留时限无效".into()); }
        let cutoff=now.saturating_sub(u64::from(days)*24*60*60*1000);
        let files=match fs::read_dir(&self.root) { Ok(files)=>files, Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(0), Err(e)=>return Err(e.to_string()) };
        let mut removed=0;
        for file in files {
            let file=file.map_err(|e|e.to_string())?;
            if !file.file_type().map_err(|e|e.to_string())?.is_file() {continue;}
            let path=file.path();if path.extension().and_then(|s|s.to_str())!=Some("json"){continue;}
            let Some(key)=path.file_stem().and_then(|s|s.to_str()) else {continue;};
            let Ok(mut record)=self.read(key) else {continue;};
            let before=record.versions.len()+usize::from(record.draft.is_some());
            record.versions.retain(|v|v.timestamp>cutoff);
            if !active.iter().any(|v|v==key) && record.draft.as_ref().is_some_and(|v|v.timestamp<=cutoff) {
                record.draft=None;record.draft_session=None;
            }
            let after=record.versions.len()+usize::from(record.draft.is_some());
            if before==after {continue;}
            if after==0 {self.clear(key)?;} else {self.write(key,&record)?;}
            removed+=before-after;
        }
        Ok(removed)
    }
    pub fn delete_entry(&self, key: &str, id: &str) -> Result<(), String> {
        let mut record = self.read(key)?;
        if record.draft.as_ref().is_some_and(|draft| draft.id == id) {
            record.draft = None;
            record.draft_session = None;
        } else if let Some(index) = record.versions.iter().position(|version| version.id == id) {
            record.versions.remove(index);
        } else {
            return Err("该记录已变化或已删除，请重新打开恢复窗口".into());
        }
        self.write(key, &record)
    }
    pub fn clear(&self, key: &str) -> Result<(), String> {
        match fs::remove_file(self.path(key)?) { Ok(()) => Ok(()), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()), Err(e) => Err(e.to_string()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_names_are_isolated_and_old_draft_survives_a_new_edit() {
        let dir = tempfile::tempdir().unwrap(); let store = Store::new(dir.path().into());
        let a = file_key(Path::new("/a/test.md")); let b = file_key(Path::new("/b/test.md"));
        store.checkpoint(&a, Some("/a/test.md".into()), "crashed", "old-session", false).unwrap();
        store.checkpoint(&a, Some("/a/test.md".into()), "new edit", "new-session", false).unwrap();
        store.checkpoint(&b, Some("/b/test.md".into()), "different file", "other-session", false).unwrap();
        let entries = store.list(&a).unwrap();
        assert_eq!(store.content(&a, &entries[1].id).unwrap(), "crashed");
        assert_eq!(store.drafts().unwrap().len(), 2);
        store.saved(&a, "older save").unwrap();
        assert_eq!(store.read(&a).unwrap().draft.unwrap().content, "new edit");
        store.saved(&a, "new edit").unwrap();
        assert!(store.read(&a).unwrap().draft.is_none());
        store.clear(&a).unwrap();
        assert_eq!(store.read(&b).unwrap().draft.unwrap().content, "different file");
    }
    #[test]
    fn history_is_bounded_and_corrupt_records_are_preserved() {
        let dir = tempfile::tempdir().unwrap(); let store = Store::new(dir.path().into());
        for n in 0..30 { store.before_save("test", "file.md".into(), Some(&n.to_string())).unwrap(); }
        assert_eq!(store.list("test").unwrap().len(), MAX_VERSIONS);
        fs::write(dir.path().join("broken.json"), "broken").unwrap();
        assert!(store.checkpoint("broken", None, "new", "test", false).is_err());
        assert_eq!(fs::read_to_string(dir.path().join("broken.json")).unwrap(), "broken");
        assert!(store.clear("../test").is_err());
    }
}

#[cfg(test)] mod expiry_tests {
 use super::*;
 #[test] fn expiry_preserves_active_drafts_recent_records_and_originals() {
  let dir=tempfile::tempdir().unwrap();let store=Store::new(dir.path().join("recovery"));
  let original=dir.path().join("文档.md");fs::write(&original,"原文").unwrap();
  let day=86_400_000;let now=100*day;
  let v=|timestamp:u64|Version{id:timestamp.to_string(),timestamp,kind:"saved".into(),content:"历史".into()};
  for key in ["active","closed"] {store.write(key,&Record{source:Some(original.to_string_lossy().into()),versions:vec![v(70*day),v(71*day),v(101*day)],draft:Some(v(10*day)),..Default::default()}).unwrap();}
  assert_eq!(store.expire(30,now,&["active".into()]).unwrap(),3);
  assert!(store.read("active").unwrap().draft.is_some());assert!(store.read("closed").unwrap().draft.is_none());
  assert_eq!(store.read("closed").unwrap().versions.len(),2);assert_eq!(fs::read_to_string(original).unwrap(),"原文");
  assert_eq!(store.expire(30,now,&["active".into()]).unwrap(),0);
 }
 #[test] fn empty_expired_records_are_removed_and_corruption_is_retained() {
  let dir=tempfile::tempdir().unwrap();let store=Store::new(dir.path().into());
  store.write("old",&Record{draft:Some(Version{id:"x".into(),timestamp:1,kind:"draft".into(),content:"old".into()}),..Default::default()}).unwrap();
  fs::write(dir.path().join("broken.json"),"broken").unwrap();
  assert_eq!(store.expire(7,20*86_400_000,&[]).unwrap(),1);assert!(!dir.path().join("old.json").exists());
  assert_eq!(fs::read_to_string(dir.path().join("broken.json")).unwrap(),"broken");
  assert!(store.expire(0,u64::MAX,&[]).is_err());
 }
}

#[cfg(test)]
mod delete_entry_tests {
    use super::*;
    #[test]
    fn deletes_only_the_selected_entry_and_rejects_stale_ids() {
        let dir=tempfile::tempdir().unwrap(); let store=Store::new(dir.path().into());
        store.before_save("doc","original.md".into(),Some("old version")).unwrap();
        store.checkpoint("doc",Some("original.md".into()),"draft one","one",false).unwrap();
        let old=store.list("doc").unwrap()[0].id.clone();
        store.checkpoint("doc",Some("original.md".into()),"draft two","two",false).unwrap();
        let current=store.list("doc").unwrap()[0].id.clone();
        store.delete_entry("doc",&old).unwrap();
        assert_eq!(store.content("doc",&current).unwrap(),"draft two");
        assert!(store.list("doc").unwrap().iter().any(|e|e.kind=="saved"));
        assert!(store.delete_entry("doc",&old).is_err());
        store.delete_entry("doc",&current).unwrap();
        let remaining=store.list("doc").unwrap();assert_eq!(remaining.len(),1);
        assert_eq!(store.content("doc",&remaining[0].id).unwrap(),"old version");
    }
}
