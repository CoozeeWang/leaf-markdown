use std::{fs::OpenOptions, io::ErrorKind, path::{Path, PathBuf}};

/// Never replace an existing entry, including a directory or dangling symlink.
#[cfg(test)]
pub fn create(folder: &Path) -> Result<PathBuf, String> { create_localized(folder, "未命名.md") }

pub fn create_localized(folder: &Path, filename: &str) -> Result<PathBuf, String> {
    let stem = filename.strip_suffix(".md").unwrap_or(filename);
    if !folder.is_dir() { return Err(crate::i18n::error("new_markdown.could_not_create_a_document_the_destination", serde_json::json!({})).into()); }
    for number in 1..=10_000 {
        let name = if number == 1 { filename.into() } else { format!("{stem} {number}.md") };
        let path = folder.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                file.sync_all().map_err(|e| crate::i18n::error("new_markdown.the_document_was_created_but_leaf_could", serde_json::json!({"path": (path.display()).to_string(), "error": (e).to_string()})))?;
                return Ok(path);
            }
            // Windows reports AccessDenied when a directory occupies the name.
            // Inspect the entry only after atomic creation failed, without following links.
            Err(e) if e.kind() == ErrorKind::AlreadyExists || path.symlink_metadata().is_ok() => continue,
            Err(e) => return Err(crate::i18n::error("new_markdown.could_not_create_a_document_in_this", serde_json::json!({"path": (folder.display()).to_string(), "error": (e).to_string()}))),
        }
    }
    Err(crate::i18n::error("new_markdown.could_not_find_an_available_default_file", serde_json::json!({})).into())
}

#[cfg(any(target_os = "windows", test))]
pub fn argument(args: &[String], cwd: &Path) -> Option<Result<PathBuf, String>> {
    if args.get(1).map(String::as_str) != Some("--new-in") { return None; }
    Some(if args.len() == 3 && !args[2].is_empty() {
        let path = PathBuf::from(&args[2]);
        Ok(if path.is_absolute() { path } else { cwd.join(path) })
    } else { Err(crate::i18n::error("new_markdown.could_not_create_a_document_no_destination", serde_json::json!({})).into()) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn creates_empty_markdown_and_preserves_collisions() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("未命名.md"), "keep").unwrap();
        std::fs::create_dir(dir.path().join("未命名 2.md")).unwrap();
        let path = create(dir.path()).unwrap();
        assert_eq!(path.file_name().unwrap(), "未命名 3.md");
        assert_eq!(std::fs::read(path).unwrap(), b"");
        assert_eq!(std::fs::read(dir.path().join("未命名.md")).unwrap(), b"keep");
    }
    #[test]
    fn concurrent_requests_get_distinct_files() {
        let dir = tempfile::tempdir().unwrap();
        let jobs: Vec<_> = (0..8).map(|_| { let p = dir.path().to_owned(); std::thread::spawn(move || create(&p).unwrap()) }).collect();
        let paths: std::collections::HashSet<_> = jobs.into_iter().map(|j| j.join().unwrap()).collect();
        assert_eq!(paths.len(), 8);
    }
    #[test]
    fn rejects_missing_and_file_targets() {
        let dir = tempfile::tempdir().unwrap();
        assert!(create(&dir.path().join("missing")).is_err());
        let file = create(dir.path()).unwrap();
        assert!(create(&file).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn does_not_follow_dangling_name_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("absent");
        std::os::unix::fs::symlink(&target, dir.path().join("未命名.md")).unwrap();
        assert_eq!(create(dir.path()).unwrap().file_name().unwrap(), "未命名 2.md");
        assert!(!target.exists());
    }
    #[cfg(unix)]
    #[test]
    fn readonly_directory_returns_error_without_creating_a_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = create(dir.path());
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
    #[test]
    fn parses_creation_separately_from_document_opening() {
        let args = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let cwd = Path::new("folder");
        assert_eq!(argument(&args(&["leaf", "--new-in", "space folder"]), cwd).unwrap().unwrap(), cwd.join("space folder"));
        assert!(argument(&args(&["leaf", "--new-in"]), cwd).unwrap().is_err());
        assert!(argument(&args(&["leaf", "sample.md"]), cwd).is_none());
    }
}
