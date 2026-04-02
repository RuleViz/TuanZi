//! atomic.rs — Atomic file writing with tmp + rename pattern.
//!
//! Mirrors the behavior of TypeScript's `atomicWriteTextFile()` in file-utils.ts.

use std::path::Path;
use tokio::fs;

/// Write `content` to `target_path` atomically.
///
/// Steps:
///   1. Create parent directories if needed
///   2. Write to a temporary file in the same directory
///   3. Remove the target (ignore if missing)
///   4. Rename temp → target
pub async fn atomic_write_text_file(target_path: &Path, content: &str) -> std::io::Result<()> {
    let directory = target_path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "No parent directory"))?;

    // The temp file name follows the same scheme as TS:
    // .{basename}.tmp-{pid}-{timestamp}-{random}
    let basename = target_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let pid = std::process::id();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let rand: u32 = rand_u32();
    let temp_name = format!(".{basename}.tmp-{pid}-{ts}-{rand:08x}");
    let temp_path = directory.join(&temp_name);

    fs::create_dir_all(directory).await?;
    fs::write(&temp_path, content).await?;

    // Remove target (ignore NotFound)
    match fs::remove_file(target_path).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            // Best-effort cleanup of temp file
            let _ = fs::remove_file(&temp_path).await;
            return Err(e);
        }
    }

    // Rename temp → target
    if let Err(e) = fs::rename(&temp_path, target_path).await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(e);
    }

    Ok(())
}

/// Simple pseudo-random u32 using thread-local state (no external rand crate needed).
fn rand_u32() -> u32 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    std::thread::current().id().hash(&mut hasher);
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .hash(&mut hasher);
    hasher.finish() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_write_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("hello.txt");

        atomic_write_text_file(&target, "hello world").await.unwrap();

        let content = fs::read_to_string(&target).await.unwrap();
        assert_eq!(content, "hello world");
    }

    #[tokio::test]
    async fn test_overwrite_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("data.txt");
        fs::write(&target, "old content").await.unwrap();

        atomic_write_text_file(&target, "new content").await.unwrap();

        let content = fs::read_to_string(&target).await.unwrap();
        assert_eq!(content, "new content");
    }

    #[tokio::test]
    async fn test_auto_create_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a").join("b").join("c").join("file.txt");

        atomic_write_text_file(&target, "nested").await.unwrap();

        let content = fs::read_to_string(&target).await.unwrap();
        assert_eq!(content, "nested");
    }

    #[tokio::test]
    async fn test_no_leftover_temp_on_success() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("clean.txt");

        atomic_write_text_file(&target, "data").await.unwrap();

        // Only the target file should exist, no .tmp files
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].file_name().to_str().unwrap(), "clean.txt");
    }
}
