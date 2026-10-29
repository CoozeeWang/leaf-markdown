// Keep in sync with src/app-links.js. No decoding or OS actions here.
pub fn is_supported(target: &str) -> bool {
    if target.len() > 2048 { return false; }
    let Some(query) = target.strip_prefix("ripple-segment-dev://open/v2?").or_else(||target.strip_prefix("ripple-transcript://open/v2?")) else { return false; };
    let fields = ["project", "recording", "model", "version", "segment", "identity"];
    let mut seen = std::collections::HashSet::new();
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else { return false; };
        if !fields.contains(&key) || !seen.insert(key) || value.is_empty() || value.len() > 160
            || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') { return false; }
        if key == "identity" && (value.len() != 36 || !value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')) { return false; }
    }
    seen.len() == fields.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_application_link_policy() {
        let cases: serde_json::Value = serde_json::from_str(include_str!("../../tests/app-link-cases.json")).unwrap();
        for value in cases["valid"].as_array().unwrap() { assert!(is_supported(value.as_str().unwrap()), "{value}"); }
        for value in cases["invalid"].as_array().unwrap() { assert!(!is_supported(value.as_str().unwrap()), "{value}"); }
    }
    #[test]
    fn named_application_link_survives_atomic_save_and_reopen() {
        let cases: serde_json::Value = serde_json::from_str(include_str!("../../tests/app-link-cases.json")).unwrap();
        for value in cases["valid"].as_array().unwrap() {
        let url = value.as_str().unwrap();
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("synthetic-segment.md");
        let content = format!("合成说话人 \\[00:10–00:20\\] (2)\n\n合成正文\n\n[合成访谈]({url})\n");
        crate::atomic_save(path.to_str().unwrap(), &content, None).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
        let edited = format!("{content}\n新增合成正文\n");
        crate::atomic_save(path.to_str().unwrap(), &edited, Some(content)).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), edited);
        assert!(edited.contains(&format!("[合成访谈]({url})")));
        }
    }

}
