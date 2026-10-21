//! Read snapshots are disposable; task acknowledgements are not. Never evict an
//! acknowledgement in a live session and accidentally allow a task to replay.
use std::collections::{HashMap, VecDeque};
use serde_json::Value;
const READ_COUNT: usize = 128;
const READ_BYTES: usize = 16 * 1024 * 1024;
const TASK_COUNT: usize = 4096;
#[derive(Default)]
pub struct ResultCache {
    values: HashMap<String, (String, Value)>,
    reads: VecDeque<(String, usize)>,
    bytes: usize,
}
impl ResultCache {
    pub fn get(&self, key: &str) -> Option<&(String, Value)> { self.values.get(key) }
    pub fn admit_task(&self) -> Result<(), String> {
        if self.values.len() - self.reads.len() >= TASK_COUNT { Err("request_history_limit: close and reopen the document before starting another task".into()) } else { Ok(()) }
    }
    pub fn insert(&mut self, key: String, value: (String, Value)) {
        if key.split(':').nth(1) == Some("begin") { self.values.insert(key, value); return; }
        let size = key.len() + value.0.len() + value.1.to_string().len();
        if size > READ_BYTES { return; }
        while self.reads.len() >= READ_COUNT || self.bytes + size > READ_BYTES {
            if let Some((old, bytes)) = self.reads.pop_front() { self.values.remove(&old); self.bytes -= bytes; } else { break; }
        }
        self.bytes += size; self.reads.push_back((key.clone(), size)); self.values.insert(key, value);
    }
    pub fn retire_session(&mut self, session: &str) {
        let prefix = format!("{session}:");
        self.values.retain(|key, _| !key.starts_with(&prefix));
        self.reads.retain(|(key, _)| !key.starts_with(&prefix));
        self.bytes = self.reads.iter().map(|(_, bytes)| bytes).sum();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test] fn snapshots_are_bounded_without_evicting_task_acknowledgements() {
        let mut cache = ResultCache::default();
        cache.insert("session:begin:first".into(), ("hash".into(), json!({"task_id":"task"})));
        for n in 0..1000 { cache.insert(format!("session:read:{n}"), ("hash".into(), json!({"content":"synthetic"}))); }
        assert_eq!(cache.reads.len(), READ_COUNT); assert_eq!(cache.values.len(), READ_COUNT + 1);
        assert!(cache.get("session:begin:first").is_some()); assert!(cache.get("session:read:0").is_none());
        cache.retire_session("session"); assert!(cache.values.is_empty()); assert_eq!(cache.bytes, 0);
    }
    #[test] fn byte_budget_and_session_isolation() {
        let mut cache = ResultCache::default();
        cache.insert("other:begin:1".into(), ("h".into(), json!({})));
        for n in 0..20 { cache.insert(format!("s:read:{n}"), ("h".into(), json!("x".repeat(1024*1024)))); }
        assert!(cache.bytes <= READ_BYTES); assert!(cache.reads.len() < 20);
        cache.insert("s:read:huge".into(), ("h".into(), json!("x".repeat(READ_BYTES+1))));
        assert!(cache.get("s:read:huge").is_none());
        cache.retire_session("s"); assert!(cache.get("other:begin:1").is_some());
    }
    #[test] fn task_limit_refuses_new_work_instead_of_forgetting_retries() {
        let mut cache = ResultCache::default();
        for n in 0..TASK_COUNT { cache.admit_task().unwrap(); cache.insert(format!("s:begin:{n}"), ("h".into(), json!({}))); }
        assert!(cache.admit_task().is_err()); assert!(cache.get("s:begin:0").is_some());
        cache.retire_session("s"); assert!(cache.admit_task().is_ok());
    }
}
