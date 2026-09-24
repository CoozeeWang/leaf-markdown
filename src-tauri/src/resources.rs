use std::{fs, io::{Read, Write}, path::{Path, PathBuf, Component}};
const LIMIT: u64 = 32 * 1024 * 1024;

pub fn resolve(document: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty() || relative.contains(['\\', ':', '\0']) { return Err("资源路径无效".into()); }
    let path = Path::new(relative);
    if path.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) { return Err("资源必须位于文档目录内".into()); }
    let root = fs::canonicalize(document.parent().ok_or("文档没有目录")?).map_err(|e| e.to_string())?;
    let target = fs::canonicalize(root.join(path)).map_err(|e| e.to_string())?;
    if !target.starts_with(&root) || !target.is_file() { return Err("资源超出文档目录或不是文件".into()); }
    Ok(target)
}
pub fn bytes(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut data = Vec::new(); file.take(LIMIT + 1).read_to_end(&mut data).map_err(|e| e.to_string())?;
    if data.len() as u64 > LIMIT { return Err("附件超过 32 MB 上限".into()); }
    Ok(data)
}
pub fn import(document: &Path, name: &str, data: &[u8]) -> Result<String, String> {
    import_managed(document, name, data, None)
}
pub fn asset_folder(document: &Path) -> String {
    format!("{}.assets", document.file_stem().unwrap_or_default().to_string_lossy())
}
pub fn import_managed(document: &Path, name: &str, data: &[u8], archive: Option<&Path>) -> Result<String, String> {
    if data.len() as u64 > LIMIT || data.is_empty() { return Err("附件为空或超过 32 MB 上限".into()); }
    let root = fs::canonicalize(document.parent().ok_or("请先保存文档")?).map_err(|e| e.to_string())?;
    let folder = asset_folder(document);
    let directory = root.join(&folder);
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let directory = fs::canonicalize(directory).map_err(|e| e.to_string())?;
    if directory.parent() != Some(root.as_path()) { return Err("assets 目录不能指向文档目录外".into()); }
    let safe: String = name.chars().take(120).map(|c| if c.is_alphanumeric() || "-_.".contains(c) { c } else { '_' }).collect();
    let safe = safe.trim_matches('.'); let safe = if safe.is_empty() { "attachment" } else { safe };
    let path = Path::new(safe); let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("attachment");
    let ext = path.extension().and_then(|v| v.to_str()).map(|v| format!(".{v}")).unwrap_or_default();
    let mut temp = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
    temp.write_all(data).map_err(|e| e.to_string())?; temp.as_file().sync_all().map_err(|e| e.to_string())?;
    for n in 0..10000 {
        let name = if n == 0 { format!("{stem}{ext}") } else { format!("{stem}-{n}{ext}") };
        if let Some(store) = archive {
            let backup = archive_path(store, document, &format!("{folder}/{name}"));
            if backup.exists() && bytes(&backup)? != data { continue; }
        }
        if fs::symlink_metadata(directory.join(&name)).map(|m| m.file_type().is_symlink()).unwrap_or(false) { continue; }
        if directory.join(&name).is_file() && bytes(&directory.join(&name)).map(|existing| existing == data).unwrap_or(false) {
            return Ok(format!("{folder}/{name}"));
        }
        match temp.persist_noclobber(directory.join(&name)) {
            Ok(_) => return Ok(format!("{folder}/{name}")),
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => temp = e.file,
            Err(e) => return Err(e.error.to_string()),
        }
    }
    Err("同名附件过多，请更换名称".into())
}
#[cfg(test)] mod tests {
 use super::*;
 #[test] fn imports_never_overwrite_and_paths_are_confined() {
  let root=tempfile::tempdir().unwrap(); let doc=root.path().join("中文.md"); fs::write(&doc,"doc").unwrap();
  assert_eq!(import(&doc,"photo.png",b"one").unwrap(),"中文.assets/photo.png");
  assert_eq!(import(&doc,"photo.png",b"two").unwrap(),"中文.assets/photo-1.png");
  assert_eq!(import(&doc,"photo.png",b"one").unwrap(),"中文.assets/photo.png");
  assert_eq!(bytes(&resolve(&doc,"中文.assets/photo.png").unwrap()).unwrap(),b"one");
  for bad in ["../secret", "/etc/passwd", "C:/secret", "assets\\photo.png"] { assert!(resolve(&doc,bad).is_err()); }
  assert_eq!(fs::read_to_string(doc).unwrap(),"doc");
 }
 #[cfg(unix)] #[test] fn rejects_symlink_escape() {
  let root=tempfile::tempdir().unwrap(); let other=tempfile::tempdir().unwrap();
  let doc=root.path().join("file.md"); fs::write(&doc,"doc").unwrap();
  std::os::unix::fs::symlink(other.path(), root.path().join("file.assets")).unwrap();
  assert!(import(&doc,"file",b"safe").is_err());
  fs::write(other.path().join("secret"),"private").unwrap();
  assert!(resolve(&doc,"assets/secret").is_err());
 }
}

// Removed pictures leave the document folder only after a successful save.
// A local recovery copy allows undo and saved history to restore the reference.
fn archive_path(store: &Path, document: &Path, name: &str) -> PathBuf {
    use sha2::{Digest, Sha256};
    let root = document.parent().unwrap_or(Path::new(""));
    let (folder, name) = name.split_once('/').unwrap_or(("assets", name));
    let identity = if folder == "assets" { root.to_path_buf() } else { root.join(folder) };
    store.join(format!("{:x}", Sha256::digest(identity.to_string_lossy().as_bytes()))).join(name)
}
fn encoded(name: &str) -> String {
    name.as_bytes().iter().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(b) { (*b as char).to_string() } else { format!("%{b:02X}") }).collect()
}
fn mentions(text: &str, name: &str) -> bool {
    // Deliberately conservative: prose, code and reference-style URLs also
    // retain a picture. False retention is preferable to deleting shared data.
    text.contains(name) || [encoded(name),encoded_path(name),link_path(name)].iter().any(|n| text.to_lowercase().contains(&n.to_lowercase()))
}
fn shared(directory: &Path, document: &Path, name: &str, depth: usize) -> Result<bool, String> {
    if depth > 20 { return Ok(true); }
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() { return Ok(true); }
        let path = entry.path();
        if kind.is_dir() {
            if entry.file_name() == "assets" || entry.file_name() == ".git" { continue; }
            if shared(&path, document, name, depth + 1)? { return Ok(true); }
        } else if path != document && path.extension().and_then(|e| e.to_str()).map(|e| matches!(e.to_lowercase().as_str(), "md" | "markdown" | "mdown")).unwrap_or(false) {
            if mentions(&fs::read_to_string(path).map_err(|e| e.to_string())?, name) { return Ok(true); }
        }
    }
    Ok(false)
}
pub fn restore(store: &Path, document: &Path, relative: &str) -> Result<(), String> {
    let path = Path::new(relative);
    let parts: Vec<_> = path.components().collect();
    if parts.len() != 2 { return Ok(()); }
    let folder = match parts[0] { Component::Normal(n) => n.to_str().unwrap_or(""), _ => return Ok(()) };
    if folder != "assets" && !folder.ends_with(".assets") { return Ok(()); }
    let name = match parts[1] { Component::Normal(n) => n.to_str().ok_or("图片名称无效")?, _ => return Ok(()) };
    if name.contains(['\\', ':']) { return Ok(()); }
    let target = document.parent().ok_or("文档没有目录")?.join(folder).join(name);
    if target.exists() { return Ok(()); }
    let backup = archive_path(store, document, relative);
    if !backup.is_file() { return Ok(()); }
    let data = bytes(&backup)?;
    let root = fs::canonicalize(document.parent().ok_or("文档没有目录")?).map_err(|e| e.to_string())?;
    let directory = root.join(folder); fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let directory = fs::canonicalize(directory).map_err(|e| e.to_string())?;
    if directory.parent() != Some(root.as_path()) { return Err("assets 目录不能指向文档目录外".into()); }
    let mut temp = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
    temp.write_all(&data).map_err(|e| e.to_string())?; temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist_noclobber(directory.join(name)).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn restore_references(store: &Path, document: &Path, content: &str) -> Result<(), String> {
    for folder in managed_folders(document, &[content])? {
        let directory = archive_path(store, document, &format!("{folder}/"));
        if !directory.exists() { continue; }
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if let Some(name) = entry.file_name().to_str() {
                if mentions(content, name) { restore(store, document, &format!("{folder}/{name}"))?; }
            }
        }
    }
    Ok(())
}
// Discover candidates from document text, never by listing its parent folder.
// Keep the conventional folders for compatibility with existing recovery ledgers.
fn managed_folders(document: &Path, texts: &[&str]) -> Result<Vec<String>, String> {
    let mut folders = vec!["assets".to_string(), asset_folder(document)];
    for text in texts {
        let bytes = text.as_bytes();
        let mut decoded = Vec::new();
        let mut at = 0;
        while at < bytes.len() {
            if bytes[at] == b'%' && at + 2 < bytes.len() {
                let hex = |b: u8| (b as char).to_digit(16);
                if let (Some(a), Some(b)) = (hex(bytes[at + 1]), hex(bytes[at + 2])) {
                    decoded.push((a * 16 + b) as u8); at += 3; continue;
                }
            }
            decoded.push(bytes[at]); at += 1;
        }
        let decoded = String::from_utf8_lossy(&decoded);
        for (end, _) in decoded.match_indices(".assets/") {
            let prefix = &decoded[..end + ".assets".len()];
            let start = prefix.rfind(|c: char| matches!(c, '\n' | '\r')).map_or(0, |i| i + 1);
            let candidate = &prefix[start..];
            // Reference definitions and whitespace-delimited prose may precede a path.
            for offset in std::iter::once(0).chain(candidate.char_indices().filter(|(_, c)| c.is_whitespace() || matches!(c, '(' | ')' | '[' | ']' | '<' | '>' | '"' | '\'' | '`')).map(|(i,c)| i+c.len_utf8())) {
                let folder = candidate[offset..].trim();
                if !folder.is_empty() && !folder.contains(['/', '\\', ':', '\0']) && folder != ".assets" {
                    folders.push(folder.to_owned());
                }
            }
        }
    }
    folders.sort(); folders.dedup(); Ok(folders)
}
fn folder_index(store: &Path, document: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    store.join(format!("folders-{:x}.json", Sha256::digest(document.to_string_lossy().as_bytes())))
}

pub fn collect_removed(store: &Path, document: &Path, before: &str, after: &str) -> Result<(), String> {
    collect_removed_protected(store, document, before, after, &[])
}
pub fn collect_removed_protected(store: &Path, document: &Path, before: &str, after: &str, buffers: &[String]) -> Result<(), String> {
    let mut folders = managed_folders(document, &[before, after])?;
    let index = folder_index(store, document);
    match fs::read(&index) {
        Ok(data) => {
            let saved: Vec<String> = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
            folders.extend(saved.into_iter().filter(|s| !s.is_empty() && !s.contains(['/', '\\', ':', '\0']) && (s == "assets" || s.ends_with(".assets"))));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
        Err(e) => return Err(e.to_string()),
    }
    folders.sort(); folders.dedup();
    // Remember nonstandard folders so deferred cleanup still works after links disappear.
    if folders.len() > 2 || index.exists() {
        fs::create_dir_all(store).map_err(|e| e.to_string())?;
        let mut record = tempfile::NamedTempFile::new_in(store).map_err(|e| e.to_string())?;
        record.write_all(&serde_json::to_vec(&folders).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        record.persist(&index).map_err(|e| e.to_string())?;
    }
    for folder in folders {
        collect_folder(store, document, before, after, buffers, &folder)?;
    }
    Ok(())
}
fn collect_folder(store: &Path, document: &Path, before: &str, after: &str, buffers: &[String], folder: &str) -> Result<(), String> {
    let root = document.parent().ok_or("文档没有目录")?;
    let assets = root.join(folder);
    use sha2::{Digest, Sha256};
    let ledger = store.join(format!("pending-{:x}.json", Sha256::digest(format!("{}:{folder}",document.display()).as_bytes())));
    let mut known: std::collections::BTreeSet<String> = match fs::read(&ledger) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
        Err(e) if e.kind()==std::io::ErrorKind::NotFound => Default::default(),
        Err(e) => return Err(e.to_string()),
    };
    if known.is_empty() && ![before, after].iter().any(|text| mentions(text, &format!("{folder}/"))) { return Ok(()); }
    if !assets.exists() { return Ok(()); }
    let entries: Vec<_> = fs::read_dir(&assets).map_err(|e| e.to_string())?.collect::<Result<_,_>>().map_err(|e| e.to_string())?;
    for entry in &entries {
        let name=entry.file_name(); let Some(name)=name.to_str() else {continue;};
        let relative=format!("{folder}/{name}");
        if [relative.clone(),encoded_path(&relative),link_path(&relative)].iter().any(|n| [before,after].iter().any(|text| text.contains(&format!("]({n})")) || text.contains(&format!("]({n} ")))) { known.insert(name.into()); }
    }
    fs::create_dir_all(store).map_err(|e| e.to_string())?;
    let mut record=tempfile::NamedTempFile::new_in(store).map_err(|e|e.to_string())?;
    record.write_all(&serde_json::to_vec(&known).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    record.as_file().sync_all().map_err(|e|e.to_string())?;record.persist(&ledger).map_err(|e|e.to_string())?;
    for entry in entries {
        let name = entry.file_name(); let Some(name) = name.to_str() else { continue; };
        let image = Path::new(name).extension().and_then(|e| e.to_str()).map(|e| matches!(e.to_lowercase().as_str(), "png"|"jpg"|"jpeg"|"gif"|"webp"|"bmp")).unwrap_or(false);
        if !image || !known.contains(name) || mentions(after, name) || buffers.iter().any(|text| mentions(text,name)) || shared(root, document, name, 0)? { continue; }
        let path = resolve(document, &format!("{folder}/{name}"))?;
        if fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?.file_type().is_symlink() { continue; }
        let data = bytes(&path)?;
        let backup = archive_path(store, document, &format!("{folder}/{name}"));
        let directory = backup.parent().unwrap(); fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
        temp.write_all(&data).map_err(|e| e.to_string())?; temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist(&backup).map_err(|e| e.to_string())?;
        if bytes(&backup)? != data || bytes(&path)? != data { return Err("图片已变化，保留原文件".into()); }
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)] mod lifecycle_tests {
 use super::*;
 #[test] fn saved_removal_restores_and_shared_references_survive() {
  let root=tempfile::tempdir().unwrap(); let store=tempfile::tempdir().unwrap();
  let doc=root.path().join("稿.md"); let before="![图](稿.assets/photo.png)";
  fs::write(&doc,before).unwrap(); import(&doc,"photo.png",b"picture").unwrap();
  fs::write(&doc,"").unwrap();
  collect_removed(store.path(),&doc,before,"").unwrap();
  assert!(!root.path().join("稿.assets/photo.png").exists());
  assert_eq!(import_managed(&doc,"photo.png",b"different",Some(store.path())).unwrap(),"稿.assets/photo-1.png");
  restore_references(store.path(),&doc,before).unwrap();
  assert_eq!(bytes(&resolve(&doc,"稿.assets/photo.png").unwrap()).unwrap(),b"picture");
  collect_removed(store.path(),&doc,before,before).unwrap();
  assert!(resolve(&doc,"稿.assets/photo.png").is_ok());
  fs::write(root.path().join("other.md"),before).unwrap();
  collect_removed(store.path(),&doc,before,"").unwrap();
  assert!(resolve(&doc,"稿.assets/photo.png").is_ok());
 }
 #[test] fn deferred_removal_retries_and_unrelated_buffers_do_not_block() {
  let root=tempfile::tempdir().unwrap(); let store=tempfile::tempdir().unwrap(); let doc=root.path().join("稿.md");
  fs::write(&doc,"").unwrap();import(&doc,"photo.png",b"picture").unwrap();let before="![图](稿.assets/photo.png)";
  collect_removed_protected(store.path(),&doc,before,"",&[before.into()]).unwrap();
  assert!(resolve(&doc,"稿.assets/photo.png").is_ok());
  collect_removed_protected(store.path(),&doc,"","",&["另一个窗口的普通正文".into()]).unwrap();
  assert!(!root.path().join("稿.assets/photo.png").exists());
  restore_references(store.path(),&doc,before).unwrap();
  collect_removed(store.path(),&doc,before,"![图](稿.assets/photo.png").unwrap();
  assert!(resolve(&doc,"稿.assets/photo.png").is_ok());
  collect_removed(store.path(),&doc,"![图](稿.assets/photo.png","").unwrap();
  assert!(!root.path().join("稿.assets/photo.png").exists());
 }
 #[test] fn encoded_picture_name_restores_exactly() {
  let root=tempfile::tempdir().unwrap(); let store=tempfile::tempdir().unwrap(); let doc=root.path().join("稿.md");
  fs::write(&doc,"").unwrap();fs::create_dir(root.path().join("assets")).unwrap();fs::write(root.path().join("assets/my photo.png"),b"picture").unwrap();
  let before="![图](assets/my%20photo.png)";
  collect_removed(store.path(),&doc,before,"").unwrap();
  assert!(!root.path().join("assets/my photo.png").exists());
  restore_references(store.path(),&doc,before).unwrap();
  assert_eq!(bytes(&resolve(&doc,"assets/my photo.png").unwrap()).unwrap(),b"picture");
 }
 #[test] fn prose_is_not_a_deleted_image_and_unrelated_assets_survive() {
  let root=tempfile::tempdir().unwrap(); let store=tempfile::tempdir().unwrap(); let doc=root.path().join("稿.md");
  fs::write(&doc,"").unwrap();import(&doc,"photo.png",b"picture").unwrap();
  collect_removed(store.path(),&doc,"photo.png","").unwrap();
  assert!(resolve(&doc,"稿.assets/photo.png").is_ok());
 }
}

// Copy before switching the document path. Originals stay available to other
// documents, undo and recovery; an existing different attachment is never replaced.
pub fn rehome(source: &Path, target: &Path, content: &str) -> Result<(String, Vec<(String,String)>), String> {
    let root=target.parent().ok_or("文档没有目录")?;
    let old_folder=asset_folder(source);
    let new_folder=asset_folder(target);
    let mut mappings=Vec::new();
    for folder in managed_folders(source, &[content])? {
        if !mentions(content, &format!("{folder}/")) { continue; }
        let directory=source.parent().ok_or("文档没有目录")?.join(&folder);
        if !directory.exists() { continue; }
        for entry in fs::read_dir(&directory).map_err(|e|e.to_string())? {
            let entry=entry.map_err(|e|e.to_string())?;
            if !entry.file_type().map_err(|e|e.to_string())?.is_file() { continue; }
            let name=entry.file_name().to_string_lossy().into_owned();
            let old=format!("{folder}/{name}");
            if !mentions(content,&old) { continue; }
            let destination=if folder==old_folder { &new_folder } else { &folder };
            let data=bytes(&resolve(source,&old)?)?;
            let dest=root.join(destination);
            fs::create_dir_all(&dest).map_err(|e|e.to_string())?;
            let dest=fs::canonicalize(dest).map_err(|e|e.to_string())?;
            if dest.parent()!=Some(fs::canonicalize(root).map_err(|e|e.to_string())?.as_path()) { return Err("附件目录超出文档目录".into()); }
            let path=dest.join(&name);
            if fs::symlink_metadata(&path).map(|m|m.file_type().is_symlink()).unwrap_or(false) { return Err("目标附件不能是符号链接".into()); }
            if path.exists() {
                if bytes(&path)?!=data { return Err(format!("目标附件已存在且内容不同：{name}")); }
            } else {
                let mut temp=tempfile::NamedTempFile::new_in(&dest).map_err(|e|e.to_string())?;
                temp.write_all(&data).map_err(|e|e.to_string())?; temp.as_file().sync_all().map_err(|e|e.to_string())?;
                temp.persist_noclobber(&path).map_err(|e|e.to_string())?;
            }
            let new=format!("{destination}/{name}");
            if old!=new { mappings.push((old,new)); }
        }
    }
    Ok((rewrite_paths(content,&mappings),mappings))
}
pub fn rewrite_paths(content: &str, mappings: &[(String,String)]) -> String {
    let mut result=String::new();
    let mut fence: Option<(char,usize)>=None;
    let mut ticks=0;
    for line in content.split_inclusive('\n') {
        let trimmed=line.trim_start();
        let marker=trimmed.chars().next().unwrap_or(' ');
        let count=trimmed.chars().take_while(|c|*c==marker).count();
        if let Some((ch,n))=fence {
            result.push_str(line);
            if marker==ch && count>=n && trimmed[count..].trim().is_empty() { fence=None; }
            continue;
        }
        if (marker=='`' || marker=='~') && count>=3 {
            fence=Some((marker,count));result.push_str(line);continue;
        }
        if line.starts_with("    ") || line.starts_with('\t') { result.push_str(line);continue; }
        let mut at=0;
        while at<line.len() {
            let next=line[at..].find('`').map(|n|at+n).unwrap_or(line.len());
            let part=&line[at..next];
            result.push_str(&if ticks==0 { rewrite_destinations(part,mappings) } else {part.to_owned()});
            if next==line.len() {break;}
            let run=line[next..].chars().take_while(|c|*c=='`').count();
            if ticks==0 {ticks=run;} else if ticks==run {ticks=0;}
            result.push_str(&line[next..next+run]);at=next+run;
        }
    }
    result
}
fn rewrite_destinations(content: &str, mappings: &[(String,String)]) -> String {
    let mut result=content.to_owned();
    for (old,new) in mappings {
        for (old,new) in [(old.clone(),new.clone()),(encoded_path(old),encoded_path(new)),(old.replace(' ',"%20").replace('(',"%28").replace(')',"%29"),new.replace(' ',"%20").replace('(',"%28").replace(')',"%29"))] {
            // Destinations only: do not rewrite prose, alt text or image titles.
            for prefix in ["](","](<"] {
                for suffix in [")"," ",">","\""] {
                    result=result.replace(&format!("{prefix}{old}{suffix}"),&format!("{prefix}{new}{suffix}"));
                }
            }
            result=result.split_inclusive('\n').map(|line| {
                if let Some((label,dest))=line.split_once("]: ") {
                    if label.trim_start().starts_with('[') && (dest.trim_end()==old || dest.starts_with(&format!("{old} "))) {
                        return format!("{label}]: {}{}",new,&dest[old.len()..]);
                    }
                }
                line.to_owned()
            }).collect();
        }
    }
    result
}
fn encoded_path(path: &str) -> String { path.split('/').map(encoded).collect::<Vec<_>>().join("/") }

fn link_path(path: &str) -> String { path.replace(' ',"%20").replace('(',"%28").replace(')',"%29") }

#[cfg(test)] mod feedback_tests {
 use super::*;
 #[test] fn document_images_are_separate_and_legacy_still_reads() {
  let root=tempfile::tempdir().unwrap();let a=root.path().join("甲.md");let b=root.path().join("乙.md");
  assert_eq!(import(&a,"photo.png",b"a").unwrap(),"甲.assets/photo.png");
  assert_eq!(import(&b,"photo.png",b"b").unwrap(),"乙.assets/photo.png");
  fs::create_dir(root.path().join("assets")).unwrap();fs::write(root.path().join("assets/old.png"),b"old").unwrap();
  assert_eq!(bytes(&resolve(&a,"assets/old.png").unwrap()).unwrap(),b"old");
 }
 #[test] fn copy_rewrites_destinations_preserves_originals_and_rejects_collisions() {
  let root=tempfile::tempdir().unwrap();let other=tempfile::tempdir().unwrap();
  let a=root.path().join("甲 稿.md");let b=other.path().join("乙 稿.md");
  import(&a,"photo.png",b"a").unwrap();
  let source="![图](甲%20稿.assets/photo.png)\n正文甲%20稿.assets/photo.png\n";
  let (text,_)=rehome(&a,&b,source).unwrap();
  assert_eq!(text,"![图](乙%20稿.assets/photo.png)\n正文甲%20稿.assets/photo.png\n");
  assert_eq!(bytes(&resolve(&b,"乙 稿.assets/photo.png").unwrap()).unwrap(),b"a");
  assert!(resolve(&a,"甲 稿.assets/photo.png").is_ok());
  fs::write(other.path().join("乙 稿.assets/photo.png"),b"different").unwrap();
  assert!(rehome(&a,&b,source).is_err());
  assert_eq!(fs::read(other.path().join("乙 稿.assets/photo.png")).unwrap(),b"different");
 }
 #[test] fn rewriting_preserves_code_examples() {
  let source="`![图](old.assets/a.png)`\n\n```md\n![图](old.assets/a.png)\n```\n\n![图](old.assets/a.png)";
  let rewritten=rewrite_paths(source,&[("old.assets/a.png".into(),"new.assets/a.png".into())]);
  assert_eq!(rewritten.matches("old.assets/a.png").count(),2);
  assert!(rewritten.ends_with("![图](new.assets/a.png)"));
 }
 #[test] fn named_archives_do_not_mix_same_image_names() {
  let root=tempfile::tempdir().unwrap();let store=tempfile::tempdir().unwrap();
  for (name,data) in [("甲",b"a"),("乙",b"b")] {
   let doc=root.path().join(format!("{name}.md"));fs::write(&doc,"").unwrap();
   let image=import(&doc,"photo.png",data).unwrap();let content=format!("![图]({image})");
   collect_removed(store.path(),&doc,&content,"").unwrap();assert!(resolve(&doc,&image).is_err());
   restore_references(store.path(),&doc,&content).unwrap();assert_eq!(bytes(&resolve(&doc,&image).unwrap()).unwrap(),data);
  }
 }
}

pub fn export_bundle(source: &Path, parent: &Path, content: &str, references: &[String]) -> Result<PathBuf,String> {
    let parent=fs::canonicalize(parent).map_err(|e|e.to_string())?;
    // Read and validate every source before creating the export folder.
    let files:Vec<_>=references.iter().map(|relative| Ok((relative,bytes(&resolve(source,relative)?)?))).collect::<Result<_,String>>()?;
    let stem=source.file_stem().ok_or("文件名无效")?.to_string_lossy();
    let mut target=None;
    for n in 0..10000 {
        let path=parent.join(if n==0 {format!("{stem}-导出")} else {format!("{stem}-导出-{n}")});
        match fs::create_dir(&path) {
            Ok(())=>{target=Some(path);break;},
            Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists=>continue,
            Err(e)=>return Err(e.to_string()),
        }
    }
    let target=target.ok_or("同名导出文件夹过多")?;
    let result: Result<(),String>=(|| {
        for (relative,data) in files {
            let path=target.join(relative);
            fs::create_dir_all(path.parent().ok_or("附件路径无效")?).map_err(|e|e.to_string())?;
            let mut file=fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e|e.to_string())?;
            file.write_all(&data).map_err(|e|e.to_string())?;file.sync_all().map_err(|e|e.to_string())?;
        }
        let mut file=fs::OpenOptions::new().write(true).create_new(true).open(target.join(source.file_name().ok_or("文件名无效")?)).map_err(|e|e.to_string())?;
        file.write_all(content.as_bytes()).map_err(|e|e.to_string())?;file.sync_all().map_err(|e|e.to_string())?;
        Ok(())
    })();
    if let Err(error)=result { return Err(format!("导出未完成，部分文件保留在 {}：{error}",target.display())); }
    Ok(target)
}

pub fn copy_references(source: &Path, target: &Path, references: &[String]) -> Result<(),String> {
    let root=fs::canonicalize(target.parent().ok_or("文档没有目录")?).map_err(|e|e.to_string())?;
    if fs::canonicalize(source.parent().ok_or("文档没有目录")?).map_err(|e|e.to_string())?==root { return Ok(()); }
    for relative in references {
        let data=bytes(&resolve(source,relative)?)?;
        let path=root.join(relative);
        let parent=path.parent().ok_or("附件路径无效")?;
        let mut ancestor=parent;
        while !ancestor.exists() { ancestor=ancestor.parent().ok_or("附件路径无效")?; }
        if !fs::canonicalize(ancestor).map_err(|e|e.to_string())?.starts_with(&root) { return Err("附件目录超出文档目录".into()); }
        fs::create_dir_all(parent).map_err(|e|e.to_string())?;
        if !fs::canonicalize(parent).map_err(|e|e.to_string())?.starts_with(&root) { return Err("附件目录超出文档目录".into()); }
        if fs::symlink_metadata(&path).map(|m|m.file_type().is_symlink()).unwrap_or(false) { return Err("目标附件不能是符号链接".into()); }
        if path.exists() {
            if bytes(&path)?!=data { return Err(format!("目标附件已存在且内容不同：{relative}")); }
        } else {
            let mut temp=tempfile::NamedTempFile::new_in(parent).map_err(|e|e.to_string())?;
            temp.write_all(&data).map_err(|e|e.to_string())?;temp.as_file().sync_all().map_err(|e|e.to_string())?;
            temp.persist_noclobber(&path).map_err(|e|e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)] mod bundle_tests {
 use super::*;
 #[test] fn export_is_portable_and_never_overwrites_existing_export() {
  let root=tempfile::tempdir().unwrap();let dest=tempfile::tempdir().unwrap();let doc=root.path().join("稿.md");
  let image=import(&doc,"photo.png",b"picture").unwrap();let content=format!("![图]({image})");
  let a=export_bundle(&doc,dest.path(),&content,&[image.clone()]).unwrap();
  let b=export_bundle(&doc,dest.path(),&content,&[image.clone()]).unwrap();assert_ne!(a,b);
  assert_eq!(fs::read_to_string(a.join("稿.md")).unwrap(),content);
  assert_eq!(bytes(&resolve(&a.join("稿.md"),&image).unwrap()).unwrap(),b"picture");
  assert!(export_bundle(&doc,dest.path(),&content,&["../secret".into()]).is_err());
 }
}

#[cfg(test)] mod privacy_tests {
    use super::*;
    #[test]
    fn text_only_resource_operations_do_not_access_document_directory() {
        let root = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        // An absent parent makes any accidental directory enumeration fail.
        let doc = root.path().join("unavailable/new.md");
        restore_references(store.path(), &doc, "plain text").unwrap();
        collect_removed(store.path(), &doc, "old text", "new text").unwrap();
        rehome(&doc, &root.path().join("elsewhere/new.md"), "plain text").unwrap();
        assert_eq!(fs::read_dir(store.path()).unwrap().count(), 0);
    }
    #[test]
    fn foreign_encoded_folder_survives_deferred_cleanup_and_restores() {
        let root = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let owner = root.path().join("别的 稿(一).md");
        let doc = root.path().join("current.md");
        fs::write(&doc, "").unwrap();
        let relative = import(&owner, "photo.png", b"picture").unwrap();
        let before = format!("![image]({})", encoded_path(&relative));
        collect_removed_protected(store.path(), &doc, &before, "", &[before.clone()]).unwrap();
        assert!(resolve(&doc, &relative).is_ok());
        collect_removed(store.path(), &doc, "", "").unwrap();
        assert!(!root.path().join(&relative).exists());
        // Recovery must not rely on discovering the folder on disk.
        fs::remove_dir(root.path().join(asset_folder(&owner))).unwrap();
        restore_references(store.path(), &doc, &before).unwrap();
        assert_eq!(bytes(&resolve(&doc, &relative).unwrap()).unwrap(), b"picture");
    }
    #[test]
    fn unrelated_asset_directories_are_not_inspected() {
        let root = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let doc = root.path().join("plain.md");
        fs::create_dir(root.path().join("unrelated.assets")).unwrap();
        fs::write(root.path().join("unrelated.assets/photo.png"), b"keep").unwrap();
        collect_removed(store.path(), &doc, "", "plain text").unwrap();
        assert_eq!(fs::read_dir(store.path()).unwrap().count(), 0);
        assert_eq!(fs::read(root.path().join("unrelated.assets/photo.png")).unwrap(), b"keep");
    }
}
