//! Keep an open handle to the document so a replacement at its old path cannot
//! be mistaken for the document the user opened.
use std::{fs::File, io::{self, Read}, path::{Path, PathBuf}};

pub struct Anchor {
    file: File,
    identity: Identity,
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct Identity {
    first: u64,
    second: u128,
}

pub struct Located {
    pub path: PathBuf,
    pub content: String,
}

impl Anchor {
    pub fn open(path: &Path) -> io::Result<Self> { Self::from_file(open_shared(path)?) }

    pub fn from_file(file: File) -> io::Result<Self> {
        let identity = identity(&file)?;
        Ok(Self { file, identity })
    }

    pub fn token(&self) -> (u64, u128) { (self.identity.first, self.identity.second) }

    pub fn matches_path(&self, path: &Path) -> bool {
        open_shared(path).and_then(|file| identity(&file)).is_ok_and(|id| id == self.identity)
    }

    pub fn locate(&self) -> io::Result<Located> {
        let candidate = path_from_handle(&self.file)?;
        // Finder and Explorer implement deletion by moving a file into the
        // system trash. That is not a user-requested document relocation.
        if is_trash_path(&candidate) { return Err(unavailable()); }
        // Read through the verified handle, then recheck the name. A concurrent
        // replacement can otherwise make the next save target another file.
        let mut file = open_shared(&candidate)?;
        if identity(&file)? != self.identity { return Err(unavailable()); }
        let mut content = String::new();
        file.read_to_string(&mut content)?;
        if !self.matches_path(&candidate) { return Err(unavailable()); }
        Ok(Located { path: candidate, content })
    }
}

#[cfg(target_os = "windows")]
fn open_shared(path: &Path) -> io::Result<File> {
    use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt};
    // Spell out Rust's default share mode. It permits Finder/Explorer moves;
    // replacing an already open target still needs a separate Windows path.
    const FILE_SHARE_READ: u32 = 1;
    const FILE_SHARE_WRITE: u32 = 2;
    const FILE_SHARE_DELETE: u32 = 4;
    OpenOptions::new().read(true).share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).open(path)
}

#[cfg(not(target_os = "windows"))]
fn open_shared(path: &Path) -> io::Result<File> { File::open(path) }

fn unavailable() -> io::Error { io::Error::new(io::ErrorKind::NotFound, "No such file or directory (tracked document unavailable)") }

fn is_trash_path(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        if std::env::var_os("HOME").is_some_and(|home| path.starts_with(Path::new(&home).join(".Trash"))) { return true; }
        return path.components().any(|part| part.as_os_str() == ".Trashes");
    }
    #[cfg(target_os = "windows")]
    { return path.components().any(|part| part.as_os_str().to_string_lossy().eq_ignore_ascii_case("$Recycle.Bin")); }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = path; false }
}

#[cfg(target_os = "macos")]
fn identity(file: &File) -> io::Result<Identity> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata()?;
    Ok(Identity { first: meta.dev(), second: meta.ino() as u128 })
}

#[cfg(target_os = "macos")]
fn path_from_handle(file: &File) -> io::Result<PathBuf> {
    use std::os::{fd::AsRawFd, unix::ffi::OsStrExt};
    unsafe extern "C" { fn fcntl(fd: i32, cmd: i32, ...) -> i32; }
    const F_GETPATH: i32 = 50;
    let mut buffer = [0u8; 1024];
    if unsafe { fcntl(file.as_raw_fd(), F_GETPATH, buffer.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }
    let len = buffer.iter().position(|byte| *byte == 0).ok_or_else(unavailable)?;
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(&buffer[..len])))
}

#[cfg(target_os = "windows")]
fn identity(file: &File) -> io::Result<Identity> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)] struct FileIdInfo { volume: u64, id: [u8; 16] }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandleEx(handle: *mut std::ffi::c_void, class: i32, info: *mut std::ffi::c_void, size: u32) -> i32;
    }
    const FILE_ID_INFO: i32 = 18;
    let mut info = std::mem::MaybeUninit::<FileIdInfo>::uninit();
    let ok = unsafe { GetFileInformationByHandleEx(file.as_raw_handle(), FILE_ID_INFO, info.as_mut_ptr().cast(), std::mem::size_of::<FileIdInfo>() as u32) };
    if ok == 0 { return Err(io::Error::last_os_error()); }
    let info = unsafe { info.assume_init() };
    Ok(Identity { first: info.volume, second: u128::from_ne_bytes(info.id) })
}

#[cfg(target_os = "windows")]
fn path_from_handle(file: &File) -> io::Result<PathBuf> {
    use std::os::windows::io::AsRawHandle;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFinalPathNameByHandleW(handle: *mut std::ffi::c_void, buffer: *mut u16, len: u32, flags: u32) -> u32;
    }
    // DOS paths are usable by ordinary Rust file I/O. Keep the verbatim prefix
    // for long paths; convert UNC names to their normal network spelling.
    const VOLUME_NAME_DOS: u32 = 0;
    let len = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), std::ptr::null_mut(), 0, VOLUME_NAME_DOS) };
    if len == 0 || len > 32768 { return Err(io::Error::last_os_error()); }
    let mut buffer = vec![0u16; len as usize + 1];
    let written = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), buffer.as_mut_ptr(), buffer.len() as u32, VOLUME_NAME_DOS) };
    if written == 0 || written as usize >= buffer.len() { return Err(io::Error::last_os_error()); }
    let name = String::from_utf16(&buffer[..written as usize]).map_err(|_| unavailable())?;
    let name = if let Some(rest) = name.strip_prefix(r"\\?\UNC\") { format!(r"\\{rest}") }
               else { name };
    Ok(PathBuf::from(name))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn identity(_file: &File) -> io::Result<Identity> { Err(io::Error::new(io::ErrorKind::Unsupported, "file tracking unsupported")) }

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn path_from_handle(_file: &File) -> io::Result<PathBuf> { Err(io::Error::new(io::ErrorKind::Unsupported, "file tracking unsupported")) }

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn follows_same_file_and_rejects_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("original.md");
        fs::write(&old, "original").unwrap();
        let anchor = Anchor::open(&old).unwrap();
        let renamed = dir.path().join("renamed.md");
        fs::rename(&old, &renamed).unwrap();
        assert_eq!(anchor.locate().unwrap().path, fs::canonicalize(&renamed).unwrap());
        let moved_dir = dir.path().join("moved");
        fs::create_dir(&moved_dir).unwrap();
        let moved = moved_dir.join("renamed.md");
        fs::rename(&renamed, &moved).unwrap();
        fs::write(&old, "substitute").unwrap();
        let located = anchor.locate().unwrap();
        assert_eq!(located.path, fs::canonicalize(&moved).unwrap());
        assert_eq!(located.content, "original");
        assert!(!anchor.matches_path(&old));
        fs::remove_file(&moved).unwrap();
        assert!(anchor.locate().is_err());
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn atomic_replacement_does_not_inherit_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document.md");
        fs::write(&path, "first").unwrap();
        let anchor = Anchor::open(&path).unwrap();
        let original = anchor.token();
        #[cfg(target_os = "windows")]
        drop(anchor);
        let temp = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        temp.persist(&path).unwrap();
        #[cfg(not(target_os = "windows"))]
        assert!(!anchor.matches_path(&path));
        assert_ne!(Anchor::open(&path).unwrap().token(), original);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_trash_is_unavailable_instead_of_a_followed_document() {
        let home = std::env::var_os("HOME").unwrap();
        assert!(is_trash_path(&Path::new(&home).join(".Trash/example.md")));
        assert!(is_trash_path(Path::new("/Volumes/External/.Trashes/501/example.md")));
        assert!(!is_trash_path(Path::new("/Volumes/External/Notes/example.md")));
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_recycle_bin_is_unavailable_instead_of_a_followed_document() {
        assert!(is_trash_path(Path::new(r"C:\$Recycle.Bin\S-1\file.md")));
        assert!(!is_trash_path(Path::new(r"C:\Notes\file.md")));
    }
}
