//! Keep atomic replacement intact while Windows releases short-lived file locks.
use std::{fs::File, io::{self, Read}, path::Path};
use sha2::{Digest, Sha256};
use tempfile::{NamedTempFile, PersistError};

fn snapshot(target: &Path) -> io::Result<Option<[u8; 32]>> {
    let mut file = match File::open(target) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut digest = Sha256::new();
    let mut buffer = [0; 16384];
    loop {
        let size = file.read(&mut buffer)?;
        if size == 0 { break; }
        digest.update(&buffer[..size]);
    }
    Ok(Some(digest.finalize().into()))
}

pub fn persist(file: NamedTempFile, target: &Path) -> Result<File, PersistError> {
    persist_with_wait(file, target, || std::thread::sleep(std::time::Duration::from_millis(50)))
}

fn persist_with_wait(mut file: NamedTempFile, target: &Path, mut wait: impl FnMut()) -> Result<File, PersistError> {
    let baseline = if cfg!(windows) {
        Some(match snapshot(target) {
            Ok(value) => value,
            Err(error) => return Err(PersistError {error, file}),
        })
    } else { None };
    let attempts = if cfg!(windows) { 21 } else { 1 };
    for attempt in 0..attempts {
        match file.persist(target) {
            Ok(saved) => return Ok(saved),
            Err(error) if attempt + 1 < attempts && matches!(error.error.raw_os_error(), Some(5 | 32 | 33)) => {
                // Reuse the same fully written temporary file. Never remove or
                // truncate the destination, and preserve the final error.
                wait();
                // A host may rewrite its configuration while we wait. Do not
                // overwrite that newer content with our earlier merged copy.
                if snapshot(target).ok().as_ref() != baseline.as_ref() { return Err(error); }
                file = error.file;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{fs::{self, OpenOptions}, io::Write, os::windows::fs::OpenOptionsExt};

    fn replacement(root: &Path) -> NamedTempFile {
        let mut file = NamedTempFile::new_in(root).unwrap();
        file.write_all(b"new synthetic content").unwrap();
        file.as_file().sync_all().unwrap();
        file
    }

    #[test]
    fn replacement_survives_a_real_temporary_windows_lock() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("record.json");
        fs::write(&target, b"old synthetic content").unwrap();
        let mut locked = Some(OpenOptions::new().read(true).share_mode(1).open(&target).unwrap());
        let file = replacement(root.path());
        let denied = fs::rename(file.path(), &target).unwrap_err();
        assert!(matches!(denied.raw_os_error(), Some(5 | 32 | 33)));
        persist_with_wait(file, &target, || {
            drop(locked.take());
            std::thread::sleep(std::time::Duration::from_millis(50));
        }).unwrap();
        assert!(locked.is_none(), "the first real replacement was blocked");
        assert_eq!(fs::read(target).unwrap(), b"new synthetic content");
    }

    #[test]
    fn persistent_windows_lock_preserves_both_files_and_returns_error() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("record.json");
        fs::write(&target, b"old synthetic content").unwrap();
        let locked = OpenOptions::new().read(true).share_mode(1).open(&target).unwrap();
        let error = persist(replacement(root.path()), &target).unwrap_err();
        assert!(matches!(error.error.raw_os_error(), Some(5 | 32 | 33)));
        assert_eq!(fs::read(&target).unwrap(), b"old synthetic content");
        assert_eq!(fs::read(error.file.path()).unwrap(), b"new synthetic content");
        drop(locked);
    }

    #[test]
    fn changed_destination_during_a_windows_lock_is_not_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("record.json");
        fs::write(&target, b"old synthetic content").unwrap();
        let mut locked = Some(OpenOptions::new().read(true).write(true).share_mode(3).open(&target).unwrap());
        let file = replacement(root.path());
        let error = persist_with_wait(file, &target, || {
            let mut writer = locked.take().unwrap();
            writer.set_len(0).unwrap();
            writer.write_all(b"new external content").unwrap();
            writer.sync_all().unwrap();
        }).unwrap_err();
        assert_eq!(fs::read(target).unwrap(), b"new external content");
        assert_eq!(fs::read(error.file.path()).unwrap(), b"new synthetic content");
    }
}
