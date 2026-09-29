use std::{fs, io::Write, path::{Path, PathBuf}, sync::Mutex};
use tauri::{menu::{MenuItem, Submenu}, AppHandle, Manager};

const LIMIT: usize = 8;

#[derive(Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq, Debug)]
pub struct Entry {
    pub path: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity: Option<(u64, u128)>,
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
struct Data { #[serde(default)] migrated: bool, #[serde(default)] entries: Vec<Entry> }

pub struct Recent {
    path: PathBuf,
    gate: Mutex<()>,
    data: Mutex<Data>,
    menu: Mutex<Option<Submenu<tauri::Wry>>>,
    blocked: bool,
}

fn name(path: &str) -> String {
    Path::new(path).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| path.into())
}

fn identity(path: &Path) -> Option<(u64, u128)> {
    crate::document_location::Anchor::open(path).ok().map(|anchor| anchor.token())
}

fn markdown(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdown"))
}

fn add(entries: &mut Vec<Entry>, path: String, identity: Option<(u64, u128)>) {
    if path.is_empty() { return; }
    entries.retain(|entry| entry.path != path);
    entries.insert(0, Entry { name: name(&path), path, identity });
    entries.truncate(LIMIT);
}

fn retain_valid(entries: &mut Vec<Entry>) {
    entries.retain(|entry| entry.identity.is_some_and(|expected| identity(Path::new(&entry.path)) == Some(expected)));
}

fn merge_legacy(data: &mut Data, old: Vec<Entry>) {
    if data.migrated { return; }
    for entry in old.into_iter().take(LIMIT) {
        if !markdown(Path::new(&entry.path)) || data.entries.iter().any(|current| current.path == entry.path) { continue; }
        data.entries.push(Entry { name: name(&entry.path), identity: identity(Path::new(&entry.path)), path: entry.path });
        data.entries.truncate(LIMIT);
    }
    data.migrated = true;
}

impl Recent {
    pub fn load(path: PathBuf) -> Self {
        let (data, blocked) = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(data) => (data, false),
                Err(error) => {
                    let backup = path.with_file_name(format!("recent-files-corrupt-{}.json", crate::recovery::unique_id()));
                    let blocked = fs::rename(&path, &backup).is_err();
                    eprintln!("Recent history is damaged ({error}); original preserved{}", if blocked { " in place" } else { " as a backup" });
                    (Data::default(), blocked)
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (Data::default(), false),
            Err(error) => { eprintln!("Recent history cannot be read: {error}"); (Data::default(), true) }
        };
        Self { path, gate: Mutex::new(()), data: Mutex::new(data), menu: Mutex::new(None), blocked }
    }

    pub fn list(&self) -> Vec<Entry> { self.data.lock().unwrap().entries.clone() }

    fn persist(&self, data: &Data) -> Result<(), String> {
        if self.blocked { return Err("最近记录尚不能写入，原记录已保留".into()); }
        let parent = self.path.parent().ok_or("最近记录位置无效")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        }
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut temp, data).map_err(|e| e.to_string())?;
        temp.flush().map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist(&self.path).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn change(&self, app: &AppHandle, update: impl FnOnce(&mut Data)) -> Result<(), String> {
        let _gate = self.gate.lock().unwrap();
        let entries = {
            let mut data = self.data.lock().unwrap();
            let mut next = data.clone();
            update(&mut next);
            self.persist(&next)?;
            *data = next;
            data.entries.clone()
        };
        self.refresh(app, &entries)
    }

    pub fn remember(&self, app: &AppHandle, path: &Path) -> Result<(), String> {
        if !markdown(path) || !path.is_file() { return Ok(()); }
        let token = identity(path).ok_or("无法确认最近文件身份")?;
        let path = path.to_string_lossy().into_owned();
        self.change(app, |data| add(&mut data.entries, path, Some(token)))
    }

    pub fn replace(&self, app: &AppHandle, old: &Path, new: &Path) -> Result<(), String> {
        let old = old.to_string_lossy().into_owned();
        let replacement = (markdown(new) && new.is_file()).then(|| identity(new).map(|token| (new.to_string_lossy().into_owned(), token))).flatten();
        self.change(app, |data| {
            data.entries.retain(|entry| entry.path != old);
            if let Some((new, token)) = replacement { add(&mut data.entries, new, Some(token)); }
        })
    }

    pub fn import(&self, app: &AppHandle, old: Vec<Entry>) -> Result<(), String> {
        if self.data.lock().unwrap().migrated { return Ok(()); }
        self.change(app, |data| merge_legacy(data, old))
    }

    pub fn clear_missing(&self, app: &AppHandle) -> Result<usize, String> {
        let before = self.list().len();
        self.change(app, |data| retain_valid(&mut data.entries))?;
        Ok(before - self.list().len())
    }

    pub fn for_id(&self, id: &str) -> Option<Entry> {
        self.data.lock().unwrap().entries.iter().find(|entry| crate::recovery::file_key(Path::new(&entry.path)) == id).cloned()
    }

    pub fn verified_path(&self, path: &str) -> Result<(PathBuf, (u64, u128)), String> {
        let data = self.data.lock().unwrap();
        let entry = data.entries.iter().find(|entry| entry.path == path).ok_or("最近文件记录已变化")?;
        let expected = entry.identity.ok_or("无法确认原文件身份；请手动打开文件")?;
        let path = PathBuf::from(path);
        if identity(&path) != Some(expected) { return Err("原文件已移动、删除或被其他文件替换".into()); }
        Ok((path, expected))
    }

    pub fn set_menu(&self, app: &AppHandle, menu: Submenu<tauri::Wry>) -> Result<(), String> {
        *self.menu.lock().unwrap() = Some(menu);
        self.refresh(app, &self.list())
    }

    fn refresh(&self, app: &AppHandle, entries: &[Entry]) -> Result<(), String> {
        let menu = self.menu.lock().unwrap();
        let Some(menu) = menu.as_ref() else { return Ok(()); };
        for item in menu.items().map_err(|e| e.to_string())? { menu.remove(&item).map_err(|e| e.to_string())?; }
        if entries.is_empty() {
            menu.append(&MenuItem::with_id(app, "recent-empty", "暂无最近打开的文件", false, None::<&str>).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        }
        for entry in entries {
            let label = format!("{} — {}", entry.name, Path::new(&entry.path).parent().unwrap_or(Path::new("")).display());
            let id = format!("recent-{}", crate::recovery::file_key(Path::new(&entry.path)));
            menu.append(&MenuItem::with_id(app, id, label, true, None::<&str>).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        }
        menu.append(&MenuItem::with_id(app, "recent-clear-missing", "清理失效记录", !entries.is_empty(), None::<&str>).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[tauri::command]
pub fn recent_list(recent: tauri::State<Recent>) -> Vec<Entry> { recent.list() }

#[tauri::command(async)]
pub fn recent_import(app: AppHandle, recent: tauri::State<Recent>, items: Vec<Entry>) -> Result<(), String> { recent.import(&app, items) }

#[tauri::command(async)]
pub fn recent_clear_missing(app: AppHandle, recent: tauri::State<Recent>) -> Result<usize, String> { recent.clear_missing(&app) }

pub fn open(app: &AppHandle, path: &str) -> Result<(), String> {
    let (verified, token) = app.state::<Recent>().verified_path(path)?;
    crate::create_document(app.clone(), Some(verified.to_string_lossy().into_owned()), None, Some(token))
}

#[tauri::command(async)]
pub fn recent_open(app: AppHandle, path: String) -> Result<(), String> { open(&app, &path) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn newest_first_deduplicated_and_bounded() {
        let mut entries = Vec::new();
        for index in 0..10 { add(&mut entries, format!("/test/{index}.md"), None); }
        assert_eq!(entries.len(), LIMIT);
        add(&mut entries, "/test/5.md".into(), None);
        assert_eq!(entries[0].name, "5.md");
        assert_eq!(entries.iter().filter(|e| e.path == "/test/5.md").count(), 1);
        add(&mut entries, String::new(), None);
        assert_eq!(entries.len(), LIMIT);
    }
    #[test]
    fn persisted_history_survives_restart_and_keeps_full_paths() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recent.json");
        let store = Recent::load(path.clone());
        let mut data = Data::default();
        add(&mut data.entries, "/synthetic/one/report.md".into(), None);
        add(&mut data.entries, "/synthetic/two/report.md".into(), None);
        data.migrated = true;
        store.persist(&data).unwrap();
        let reopened = Recent::load(path);
        assert_eq!(reopened.list(), data.entries);
        assert!(reopened.data.lock().unwrap().migrated);
        assert_ne!(reopened.list()[0].path, reopened.list()[1].path);
    }
    #[test]
    fn cleanup_removes_missing_and_unverified_files() {
        let dir = tempfile::tempdir().unwrap();
        let present = dir.path().join("present.md");
        fs::write(&present, "# Synthetic").unwrap();
        let missing = dir.path().join("missing.md");
        let mut entries = Vec::new();
        add(&mut entries, present.to_string_lossy().into_owned(), identity(&present));
        add(&mut entries, missing.to_string_lossy().into_owned(), None);
        retain_valid(&mut entries);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, present.to_string_lossy());
    }
    #[test]
    fn damaged_history_is_preserved_before_new_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recent.json");
        fs::write(&path, "not json").unwrap();
        let store = Recent::load(path.clone());
        assert!(store.list().is_empty());
        assert!(!store.blocked);
        assert!(!path.exists());
        assert!(fs::read_dir(dir.path()).unwrap().any(|item| item.unwrap().path().file_name().unwrap().to_string_lossy().starts_with("recent-files-corrupt-")));
    }
    #[test]
    fn legacy_import_appends_once_without_resurrecting_removed_entries() {
        let mut data = Data::default();
        add(&mut data.entries, "/synthetic/current.md".into(), None);
        let old = vec![Entry { path: "/synthetic/old.md".into(), name: "old.md".into(), identity: None }];
        merge_legacy(&mut data, old.clone());
        assert_eq!(data.entries.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(), ["current.md", "old.md"]);
        data.entries.pop();
        merge_legacy(&mut data, old);
        assert_eq!(data.entries.len(), 1);
    }
    #[test]
    fn only_markdown_extensions_are_recent_candidates() {
        assert!(markdown(Path::new("/synthetic/note.MD")));
        assert!(markdown(Path::new("/synthetic/note.markdown")));
        assert!(!markdown(Path::new("/synthetic/note.txt")));
        assert!(!markdown(Path::new("/synthetic/unsaved")));
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn replaced_file_at_same_path_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, "original").unwrap();
        let token = identity(&path).unwrap();
        let store = Recent::load(dir.path().join("recent.json"));
        add(&mut store.data.lock().unwrap().entries, path.to_string_lossy().into_owned(), Some(token));
        assert_eq!(store.verified_path(path.to_str().unwrap()).unwrap().0, path);
        fs::rename(&path, dir.path().join("moved.md")).unwrap();
        fs::write(&path, "unrelated").unwrap();
        assert!(store.verified_path(path.to_str().unwrap()).is_err());
        let mut entries = store.list();
        retain_valid(&mut entries);
        assert!(entries.is_empty());
    }
}
