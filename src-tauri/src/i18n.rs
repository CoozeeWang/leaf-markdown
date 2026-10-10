use std::{fs, io::Write, path::PathBuf, sync::{Mutex, OnceLock}};
use tauri::{Emitter, Manager, menu::{MenuItemKind, Menu}};

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Snapshot { pub preference: String, pub language: String, pub revision: u64 }
pub struct Language { path: PathBuf, data: Mutex<Snapshot>, menu: Mutex<Vec<(MenuItemKind<tauri::Wry>, String)>> }
fn valid(value: &str) -> bool { ["system", "zh-Hans", "zh-Hant-TW", "en"].contains(&value) }
pub fn resolve(tag: &str) -> &'static str {
    let normalized = tag.replace('_', "-").to_lowercase();
    let parts: Vec<_> = normalized.split('-').collect();
    if parts.first() != Some(&"zh") { return "en"; }
    if parts.contains(&"hant") { return "zh-Hant-TW"; }
    if parts.contains(&"hans") { return "zh-Hans"; }
    if parts.iter().any(|p| ["tw", "hk", "mo"].contains(p)) { "zh-Hant-TW" } else { "zh-Hans" }
}
fn effective(preference: &str) -> String {
    if preference == "system" { resolve(&sys_locale::get_locale().unwrap_or_default()).into() } else { preference.into() }
}
fn catalogs() -> &'static [serde_json::Value; 4] {
    static CATALOGS: OnceLock<[serde_json::Value; 4]> = OnceLock::new();
    CATALOGS.get_or_init(|| [
        serde_json::from_str(include_str!("../../src/locales/zh-Hans.json")).unwrap(),
        serde_json::from_str(include_str!("../../src/locales/zh-Hant-TW.json")).unwrap(),
        serde_json::from_str(include_str!("../../src/locales/en.json")).unwrap(),
        serde_json::from_str(include_str!("../../src/locales/copy-keys.json")).unwrap(),
    ])
}
pub fn text(language: &str, key: &str) -> String {
    let catalogs = catalogs();
    let key = catalogs[3][key].as_str().unwrap_or(key);
    let index = match language { "zh-Hans" => 0, "zh-Hant-TW" => 1, _ => 2 };
    catalogs[index][key].as_str().or_else(|| catalogs[2][key].as_str()).unwrap_or(key).into()
}
impl Language {
    pub fn load(path: PathBuf) -> Self {
        let preference = fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|v| v["preference"].as_str().filter(|p| valid(p)).map(str::to_owned)).unwrap_or("system".into());
        Self { path, data: Mutex::new(Snapshot { language: effective(&preference), preference, revision: 0 }), menu: Mutex::new(Vec::new()) }
    }
    pub fn current(&self) -> String { self.data.lock().unwrap().language.clone() }
    pub fn attach_menu(&self, menu: &Menu<tauri::Wry>) -> tauri::Result<()> {
        // Capture stable menu objects once; subsequent switches only change
        // labels and retain IDs, accelerators, actions and the recent submenu.
        fn walk(items: Vec<MenuItemKind<tauri::Wry>>, into: &mut Vec<(MenuItemKind<tauri::Wry>, String)>) -> tauri::Result<()> {
            let zh = &catalogs()[0];
            for item in items {
                let label = match &item { MenuItemKind::MenuItem(i) => i.text()?, MenuItemKind::Submenu(i) => i.text()?, MenuItemKind::Predefined(i) => i.text()?, _ => continue };
                let key = match label.as_str() { "&Copy" | "Copy" => Some("native.copy".into()), "Cu&t" | "Cut" => Some("native.cut".into()), "&Paste" | "Paste" => Some("native.paste".into()), "Select &All" | "Select All" => Some("native.select_all".into()), "Leaf" => None,
                    _ => zh.as_object().unwrap().iter().find(|(_, v)| v.as_str() == Some(&label)).map(|(k, _)| k.clone()) };
                if let MenuItemKind::Submenu(submenu) = &item { walk(submenu.items()?, into)?; }
                if let Some(key) = key { into.push((item, key)); }
            }
            Ok(())
        }
        let mut items = Vec::new(); walk(menu.items()?, &mut items)?;
        *self.menu.lock().unwrap() = items;
        self.update_menu(&self.current())
    }
    fn update_menu(&self, language: &str) -> tauri::Result<()> {
        for (item, key) in self.menu.lock().unwrap().iter() {
            let label = text(language, key).replace('&', "&&");
            match item { MenuItemKind::MenuItem(i) => i.set_text(label)?, MenuItemKind::Submenu(i) => i.set_text(label)?, MenuItemKind::Predefined(i) => i.set_text(label)?, _ => {} }
        }
        Ok(())
    }
    fn persist(&self, preference: &str) -> Result<(), String> {
        let parent = self.path.parent().ok_or("language-persist-failed")?;
        fs::create_dir_all(parent).map_err(|_| "language-persist-failed")?;
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| "language-persist-failed")?;
        serde_json::to_writer(&mut temp, &serde_json::json!({"preference": preference})).map_err(|_| "language-persist-failed")?;
        temp.flush().and_then(|_| temp.as_file().sync_all()).map_err(|_| "language-persist-failed")?;
        temp.persist(&self.path).map_err(|_| "language-persist-failed")?;
        Ok(())
    }
    fn refresh(&self, preference: Option<String>, app: &tauri::AppHandle) -> Result<Snapshot, String> {
        let mut data = self.data.lock().unwrap();
        let next = preference.unwrap_or_else(|| data.preference.clone());
        if !valid(&next) { return Err("invalid-language-preference".into()); }
        let language = effective(&next);
        if data.preference != next || data.language != language {
            if data.preference != next { self.persist(&next)?; }
            *data = Snapshot { preference: next, language, revision: data.revision + 1 };
            let snapshot = data.clone(); drop(data);
            if let Err(error) = self.update_menu(&snapshot.language) { eprintln!("Language menu refresh: {error}"); }
            if let Err(error) = app.state::<crate::recent::Recent>().refresh_language(app) { eprintln!("Recent language refresh: {error}"); }
            if let Err(error) = app.emit("leaf-language-changed", &snapshot) { eprintln!("Language broadcast: {error}"); }
            Ok(snapshot)
        } else { Ok(data.clone()) }
    }
}
#[tauri::command]
pub fn language_get(app: tauri::AppHandle) -> Result<Snapshot, String> { app.state::<Language>().refresh(None, &app) }
#[tauri::command]
pub fn language_set(app: tauri::AppHandle, preference: String) -> Result<Snapshot, String> { app.state::<Language>().refresh(Some(preference), &app) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn matches_scripts_regions_and_fallback() {
        for (tag, expected) in [("zh-Hant-HK", "zh-Hant-TW"), ("zh-Hans-TW", "zh-Hans"), ("zh_SG", "zh-Hans"), ("zh-MO", "zh-Hant-TW"), ("zh", "zh-Hans"), ("en-GB", "en"), ("ja-JP", "en")] { assert_eq!(resolve(tag), expected); }
    }
    #[test] fn saves_and_reloads_and_reports_failure() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("language.json");
        let state = Language::load(path.clone()); assert_eq!(state.data.lock().unwrap().preference, "system");
        state.persist("zh-Hant-TW").unwrap(); assert_eq!(Language::load(path).current(), "zh-Hant-TW");
        let blocked = dir.path().join("blocked"); fs::write(&blocked, "keep").unwrap();
        assert_eq!(Language::load(blocked.join("language.json")).persist("en").unwrap_err(), "language-persist-failed");
        assert_eq!(fs::read_to_string(blocked).unwrap(), "keep");
    }
    #[test] fn errors_and_quantities_reuse_shared_resources() {
        let payload = error("main.removed_unavailable_entries", serde_json::json!({"count":1}));
        assert_eq!(format_error("en", &payload), "Removed 1 unavailable entry.");
        assert_eq!(render("en", "NA0071", &serde_json::json!({"count":0})), "Removed 0 unavailable entries.");
        assert_eq!(format_error("zh-Hant-TW", "Permission denied (os error 13)"), "Permission denied (os error 13)");
        let unknown = error("unknown-code", serde_json::json!({}));
        assert_eq!(format_error("en", &unknown), unknown);
    }
    #[test] fn native_uses_shared_approved_copy() { assert_eq!(text("zh-Hant-TW", "NA0067"), "還原"); assert_eq!(text("en", "NA0052"), "New"); }
}

/// The existing command error transport remains a String, carrying a stable
/// code and parameters rather than a localized sentence or an OS diagnosis.
pub fn error(key: &str, params: serde_json::Value) -> String {
    serde_json::json!({"leafError": 1, "code": key, "params": params}).to_string()
}
pub fn render(language: &str, key: &str, params: &serde_json::Value) -> String {
    let key = catalogs()[3][key].as_str().unwrap_or(key);
    let plural = params["count"].as_u64().map(|count| format!("{key}_{}", if count == 1 { "one" } else { "other" }));
    let key = plural.as_deref().filter(|key| catalogs()[2][*key].is_string()).unwrap_or(key);
    let mut result = text(language, key);
    if let Some(params) = params.as_object() {
        for (name, value) in params {
            let value = value.as_str().map(|s| format_error(language, s)).unwrap_or_else(|| value.to_string());
            result = result.replace(&format!("{{{{{name}}}}}"), &value);
        }
    }
    result
}
pub fn format_error(language: &str, value: &str) -> String {
    if let Ok(error) = serde_json::from_str::<serde_json::Value>(value) {
        if error["leafError"] == 1 {
            if let Some(code) = error["code"].as_str().filter(|code| catalogs()[2][*code].is_string()) { return render(language, code, &error["params"]); }
        }
    }
    value.into()
}
pub fn app_text(app: &tauri::AppHandle, key: &str) -> String { text(&app.state::<Language>().current(), key) }
pub fn app_error(app: &tauri::AppHandle, error: &str) -> String { format_error(&app.state::<Language>().current(), error) }
