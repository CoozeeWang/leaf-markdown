// Render into a sibling temporary file so failure never damages an existing PDF.
use std::{fs, io::Read, path::Path};
use tempfile::TempPath;

pub fn file_name(name: &str) -> String {
    let name = Path::new(name).file_name().and_then(|s| s.to_str()).unwrap_or("Leaf");
    let stem = [".markdown", ".mdown", ".md"].into_iter()
        .find_map(|ext| name.to_ascii_lowercase().ends_with(ext).then(|| &name[..name.len() - ext.len()]))
        .unwrap_or(name);
    format!("{stem}.pdf")
}

pub fn prepare(target: &Path) -> Result<TempPath, String> {
    if !target.is_absolute() || !target.extension().is_some_and(|s| s.eq_ignore_ascii_case("pdf")) {
        return Err("Choose a PDF file.".into());
    }
    tempfile::Builder::new().prefix(".leaf-pdf-").suffix(".pdf")
        .tempfile_in(target.parent().ok_or("Invalid PDF location.")?)
        // WebView2 must be the only process holding the output while printing.
        // Keep RAII cleanup of the name, but close our reservation handle.
        .map(|file| file.into_temp_path()).map_err(|e| e.to_string())
}

pub fn finish(temp: TempPath, target: &Path) -> Result<(), String> {
    // Reopen after WebView2 finishes, rather than trusting a success callback alone.
    let mut file = fs::OpenOptions::new().read(true).write(true).open(&temp).map_err(|e| e.to_string())?;
    let mut signature = [0; 5];
    file.read_exact(&mut signature).map_err(|e| e.to_string())?;
    if signature != *b"%PDF-" { return Err("The PDF renderer did not produce a PDF.".into()); }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    temp.persist(target).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_unicode_file_name() {
        assert_eq!(file_name("中文標題-😀.markdown"), "中文標題-😀.pdf");
        assert_eq!(file_name("English.md"), "English.pdf");
        assert_eq!(file_name("Draft 1.2"), "Draft 1.2.pdf");
    }
    #[test]
    fn failed_render_preserves_existing_pdf_and_removes_temp() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("中文.pdf");
        fs::write(&target, b"existing PDF").unwrap();
        let temp = prepare(&target).unwrap();
        let scratch = temp.to_path_buf();
        fs::write(&scratch, b"failed").unwrap();
        assert!(finish(temp, &target).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"existing PDF");
        assert!(!scratch.exists());
        assert!(prepare(&dir.path().join("source.md")).is_err());
    }
    #[test]
    fn replaces_only_after_valid_render() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("export.PDF");
        fs::write(&target, b"old PDF").unwrap();
        let temp = prepare(&target).unwrap();
        fs::write(&temp, b"%PDF-1.7\nnew content").unwrap();
        finish(temp, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"%PDF-1.7\nnew content");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn renderer_gets_an_exclusive_writer_after_reservation_closes() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let legacy = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        let exclusive = |path: &Path| fs::OpenOptions::new().write(true).share_mode(0).open(path);
        assert!(exclusive(legacy.path()).is_err(), "control: a held reservation blocks exclusive output");
        let target = dir.path().join("synthetic.pdf");
        let output = prepare(&target).unwrap();
        let writer = exclusive(&output).expect("the external renderer must acquire the reserved path");
        drop(writer);
        drop(output);
        assert!(!target.exists());
    }

}
