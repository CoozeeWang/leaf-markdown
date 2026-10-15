// Render into a sibling temporary file so failure never damages an existing PDF.
use std::{fs, io::Read, path::Path};
use tempfile::NamedTempFile;

pub fn file_name(name: &str) -> String {
    let name = Path::new(name).file_name().and_then(|s| s.to_str()).unwrap_or("Leaf");
    let stem = [".markdown", ".mdown", ".md"].into_iter()
        .find_map(|ext| name.to_ascii_lowercase().ends_with(ext).then(|| &name[..name.len() - ext.len()]))
        .unwrap_or(name);
    format!("{stem}.pdf")
}

pub fn prepare(target: &Path) -> Result<NamedTempFile, String> {
    if !target.is_absolute() || !target.extension().is_some_and(|s| s.eq_ignore_ascii_case("pdf")) {
        return Err("Choose a PDF file.".into());
    }
    tempfile::Builder::new().prefix(".leaf-pdf-").suffix(".pdf")
        .tempfile_in(target.parent().ok_or("Invalid PDF location.")?).map_err(|e| e.to_string())
}

pub fn finish(temp: NamedTempFile, target: &Path) -> Result<(), String> {
    // Reopen after WebView2 finishes, rather than trusting a success callback alone.
    let mut file = fs::File::open(temp.path()).map_err(|e| e.to_string())?;
    let mut signature = [0; 5];
    file.read_exact(&mut signature).map_err(|e| e.to_string())?;
    if signature != *b"%PDF-" { return Err("The PDF renderer did not produce a PDF.".into()); }
    drop(file);
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
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
        let scratch = temp.path().to_owned();
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
        fs::write(temp.path(), b"%PDF-1.7\nnew content").unwrap();
        finish(temp, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"%PDF-1.7\nnew content");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
