//! checkpoint.rs — Turn checkpoint manager (workspace snapshot + restore).
//!
//! Mirrors `TurnCheckpointManager` from turn-checkpoint-manager.ts.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use sha2::{Sha256, Digest};
use tokio::fs;
use tool_protocol::{
    CheckpointCreateArgs, CheckpointIndex, CheckpointManifest,
    CheckpointRestoreArgs, ManifestEntry, RestoreResult, TurnCheckpoint,
    ToolResponse,
};

const CHECKPOINTS_DIR: &str = "checkpoints";
const INDEX_FILE: &str = "index.json";
const MANIFESTS_DIR: &str = "manifests";
const BLOBS_DIR: &str = "blobs";
const MAX_CHECKPOINTS_DEFAULT: usize = 50;
const MESSAGE_PREVIEW_LENGTH: usize = 200;

const WORKSPACE_EXCLUDES: &[&str] = &[
    ".git", ".tuanzi", "node_modules", ".npm-cache", ".tmp", "dist", "tmp", ".mycoderagent",
];

/// Create a workspace checkpoint.
pub async fn create_checkpoint(args: CheckpointCreateArgs, workspace_root: &str) -> ToolResponse {
    let checkpoint_root = Path::new(workspace_root).join(".tuanzi").join(CHECKPOINTS_DIR);
    let max_checkpoints = args.max_checkpoints.unwrap_or(MAX_CHECKPOINTS_DEFAULT);

    // Ensure dirs
    if let Err(e) = ensure_initialized(&checkpoint_root).await {
        return ToolResponse::failure(format!("Failed to initialize checkpoint dirs: {e}"));
    }

    // Snapshot workspace
    let manifest = match snapshot_workspace(workspace_root, &checkpoint_root).await {
        Ok(m) => m,
        Err(e) => return ToolResponse::failure(format!("Failed to snapshot workspace: {e}")),
    };

    // Load index
    let mut index = load_index(&checkpoint_root).await;

    // Check if identical to last checkpoint
    if let Some(last_cp) = index.checkpoints.last() {
        if let Some(last_manifest) = load_manifest(&checkpoint_root, &last_cp.id).await {
            if manifests_equal(&manifest, &last_manifest) {
                return match serde_json::to_value(last_cp) {
                    Ok(v) => ToolResponse::success(v),
                    Err(e) => ToolResponse::failure(format!("Serialization error: {e}")),
                };
            }
        }
    }

    let preview = truncate_message(&args.user_message, MESSAGE_PREVIEW_LENGTH);
    let checkpoint = TurnCheckpoint {
        id: args.turn_id.clone(),
        turn_index: args.turn_index,
        user_message: preview,
        created_at: now_iso(),
        tool_calls: vec![],
    };

    // Save manifest
    if let Err(e) = save_manifest(&checkpoint_root, &args.turn_id, &manifest).await {
        return ToolResponse::failure(format!("Failed to save manifest: {e}"));
    }

    index.checkpoints.push(checkpoint.clone());

    // Prune and GC
    prune_and_gc(&checkpoint_root, &mut index, max_checkpoints).await;

    // Save index
    if let Err(e) = save_index(&checkpoint_root, &index).await {
        return ToolResponse::failure(format!("Failed to save index: {e}"));
    }

    match serde_json::to_value(&checkpoint) {
        Ok(v) => ToolResponse::success(v),
        Err(e) => ToolResponse::failure(format!("Serialization error: {e}")),
    }
}

/// Restore workspace to a checkpoint.
pub async fn restore_checkpoint(args: CheckpointRestoreArgs, workspace_root: &str) -> ToolResponse {
    let checkpoint_root = Path::new(workspace_root).join(".tuanzi").join(CHECKPOINTS_DIR);

    let mut index = load_index(&checkpoint_root).await;
    let cp_pos = index.checkpoints.iter().position(|cp| cp.id == args.turn_id);
    if cp_pos.is_none() {
        return ToolResponse::failure(format!("Checkpoint not found: {}", args.turn_id));
    }
    let cp_pos = cp_pos.unwrap();

    let manifest = match load_manifest(&checkpoint_root, &args.turn_id).await {
        Some(m) => m,
        None => return ToolResponse::failure(format!("Manifest not found for checkpoint: {}", args.turn_id)),
    };

    let stats = match restore_from_manifest(workspace_root, &checkpoint_root, &manifest).await {
        Ok(s) => s,
        Err(e) => return ToolResponse::failure(format!("Restore failed: {e}")),
    };

    // Truncate checkpoints after the restored one
    index.checkpoints.truncate(cp_pos + 1);
    let _ = save_index(&checkpoint_root, &index).await;

    let result = RestoreResult {
        restored_files: stats.0,
        removed_files: stats.1,
    };
    match serde_json::to_value(&result) {
        Ok(v) => ToolResponse::success(v),
        Err(e) => ToolResponse::failure(format!("Serialization error: {e}")),
    }
}

/// Update tool calls for an existing checkpoint.
pub async fn update_tool_calls(turn_id: &str, tool_calls: Vec<String>, workspace_root: &str) -> ToolResponse {
    let checkpoint_root = Path::new(workspace_root).join(".tuanzi").join(CHECKPOINTS_DIR);
    let mut index = load_index(&checkpoint_root).await;

    if let Some(cp) = index.checkpoints.iter_mut().find(|cp| cp.id == turn_id) {
        cp.tool_calls = tool_calls;
        if let Err(e) = save_index(&checkpoint_root, &index).await {
            return ToolResponse::failure(format!("Failed to save index: {e}"));
        }
    }

    ToolResponse::success(serde_json::json!({"ok": true}))
}

/// List all checkpoints.
pub async fn list_checkpoints(workspace_root: &str) -> ToolResponse {
    let checkpoint_root = Path::new(workspace_root).join(".tuanzi").join(CHECKPOINTS_DIR);
    let index = load_index(&checkpoint_root).await;
    match serde_json::to_value(&index.checkpoints) {
        Ok(v) => ToolResponse::success(v),
        Err(e) => ToolResponse::failure(format!("Serialization error: {e}")),
    }
}

/// Get diff summary between a checkpoint and current workspace state.
pub async fn diff_checkpoint(turn_id: &str, workspace_root: &str) -> ToolResponse {
    let checkpoint_root = Path::new(workspace_root).join(".tuanzi").join(CHECKPOINTS_DIR);
    let index = load_index(&checkpoint_root).await;

    if !index.checkpoints.iter().any(|cp| cp.id == turn_id) {
        return ToolResponse::failure(format!("Checkpoint not found: {turn_id}"));
    }

    let old_manifest = match load_manifest(&checkpoint_root, turn_id).await {
        Some(m) => m,
        None => return ToolResponse::failure("Manifest not found.".to_string()),
    };

    let current_manifest = match snapshot_workspace_manifest_only(workspace_root).await {
        Ok(m) => m,
        Err(e) => return ToolResponse::failure(format!("Failed to snapshot workspace: {e}")),
    };

    let summary = build_diff_summary(&old_manifest, &current_manifest);
    ToolResponse::success(serde_json::json!({"diff": summary}))
}

// ── Internal helpers ──

async fn ensure_initialized(checkpoint_root: &Path) -> std::io::Result<()> {
    fs::create_dir_all(checkpoint_root.join(MANIFESTS_DIR)).await?;
    fs::create_dir_all(checkpoint_root.join(BLOBS_DIR)).await?;
    Ok(())
}

async fn snapshot_workspace(
    workspace_root: &str,
    checkpoint_root: &Path,
) -> std::io::Result<CheckpointManifest> {
    let files = collect_files(Path::new(workspace_root), WORKSPACE_EXCLUDES).await;
    let mut manifest = CheckpointManifest {
        files: HashMap::new(),
    };

    for rel_path in &files {
        let abs_path = Path::new(workspace_root).join(rel_path);
        let content = match fs::read(&abs_path).await {
            Ok(c) => c,
            Err(_) => continue,
        };

        let hash = sha256_hex(&content);
        let normalized = rel_path.replace('\\', "/");
        manifest.files.insert(
            normalized,
            ManifestEntry {
                hash: hash.clone(),
                size: content.len() as u64,
            },
        );

        // Store blob
        let blob_path = blob_path(checkpoint_root, &hash);
        if !blob_path.exists() {
            if let Some(parent) = blob_path.parent() {
                fs::create_dir_all(parent).await?;
            }
            let tmp_path = format!("{}.tmp.{}", blob_path.display(), timestamp_millis());
            fs::write(&tmp_path, &content).await?;
            // Atomic rename
            if let Err(_) = fs::rename(&tmp_path, &blob_path).await {
                let _ = fs::remove_file(&tmp_path).await;
            }
        }
    }

    Ok(manifest)
}

/// Snapshot workspace for diff only (no blob storage).
async fn snapshot_workspace_manifest_only(workspace_root: &str) -> std::io::Result<CheckpointManifest> {
    let files = collect_files(Path::new(workspace_root), WORKSPACE_EXCLUDES).await;
    let mut manifest = CheckpointManifest {
        files: HashMap::new(),
    };

    for rel_path in &files {
        let abs_path = Path::new(workspace_root).join(rel_path);
        let content = match fs::read(&abs_path).await {
            Ok(c) => c,
            Err(_) => continue,
        };

        let hash = sha256_hex(&content);
        let normalized = rel_path.replace('\\', "/");
        manifest.files.insert(
            normalized,
            ManifestEntry {
                hash,
                size: content.len() as u64,
            },
        );
    }

    Ok(manifest)
}

async fn restore_from_manifest(
    workspace_root: &str,
    checkpoint_root: &Path,
    manifest: &CheckpointManifest,
) -> std::io::Result<(usize, usize)> {
    let mut restored = 0usize;
    let mut removed = 0usize;
    let manifest_paths: HashSet<String> = manifest
        .files
        .keys()
        .map(|k| k.replace('\\', "/").to_lowercase())
        .collect();

    // 1. Restore files
    for (rel_path, entry) in &manifest.files {
        let dest = Path::new(workspace_root).join(rel_path);
        let bp = blob_path(checkpoint_root, &entry.hash);

        // Check if current content matches
        if let Ok(current) = fs::read(&dest).await {
            let current_hash = sha256_hex(&current);
            if current_hash == entry.hash {
                continue;
            }
        }

        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).await?;
        }
        if let Err(e) = fs::copy(&bp, &dest).await {
            eprintln!("Failed to restore {rel_path}: {e}");
            continue;
        }
        restored += 1;
    }

    // 2. Remove files not in manifest
    let workspace_files = collect_files(Path::new(workspace_root), WORKSPACE_EXCLUDES).await;
    for rel_path in &workspace_files {
        let normalized = rel_path.replace('\\', "/").to_lowercase();
        if !manifest_paths.contains(&normalized) {
            let target = Path::new(workspace_root).join(rel_path);
            if fs::remove_file(&target).await.is_ok() {
                removed += 1;
            }
        }
    }

    // 3. Clean empty dirs
    if removed > 0 {
        remove_empty_dirs(Path::new(workspace_root), WORKSPACE_EXCLUDES).await;
    }

    Ok((restored, removed))
}

async fn collect_files(root: &Path, excludes: &[&str]) -> Vec<String> {
    let mut results = Vec::new();
    collect_files_recursive(root, "", excludes, &mut results).await;
    results
}

async fn collect_files_recursive(
    dir: &Path,
    rel: &str,
    excludes: &[&str],
    results: &mut Vec<String>,
) {
    let mut entries = match fs::read_dir(dir).await {
        Ok(e) => e,
        Err(_) => return,
    };

    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        let entry_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };

        if should_exclude(&entry_rel, excludes) {
            continue;
        }

        let file_type = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        if file_type.is_dir() {
            Box::pin(collect_files_recursive(&entry.path(), &entry_rel, excludes, results)).await;
        } else if file_type.is_file() {
            results.push(entry_rel);
        }
    }
}

fn should_exclude(rel_path: &str, excludes: &[&str]) -> bool {
    let parts: Vec<&str> = rel_path.split('/').collect();
    for part in &parts {
        for exclude in excludes {
            if exclude.starts_with("*.") {
                if part.ends_with(&exclude[1..]) {
                    return true;
                }
            } else if *part == *exclude {
                return true;
            }
        }
    }
    false
}

async fn remove_empty_dirs(root: &Path, excludes: &[&str]) {
    let mut entries = match fs::read_dir(root).await {
        Ok(e) => e,
        Err(_) => return,
    };

    while let Ok(Some(entry)) = entries.next_entry().await {
        let ft = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if excludes.contains(&name.as_str()) {
            continue;
        }
        let dir_path = entry.path();
        Box::pin(remove_empty_dirs(&dir_path, excludes)).await;
        // Check if now empty
        if let Ok(mut remaining) = fs::read_dir(&dir_path).await {
            if remaining.next_entry().await.map(|e| e.is_none()).unwrap_or(true) {
                let _ = fs::remove_dir(&dir_path).await;
            }
        }
    }
}

fn blob_path(checkpoint_root: &Path, hash: &str) -> PathBuf {
    checkpoint_root
        .join(BLOBS_DIR)
        .join(&hash[..2])
        .join(hash)
}

async fn load_index(checkpoint_root: &Path) -> CheckpointIndex {
    let index_path = checkpoint_root.join(INDEX_FILE);
    if let Ok(content) = fs::read_to_string(&index_path).await {
        if let Ok(parsed) = serde_json::from_str::<CheckpointIndex>(&content) {
            if parsed.version == 2 {
                return parsed;
            }
        }
    }
    CheckpointIndex {
        version: 2,
        checkpoints: vec![],
    }
}

async fn save_index(checkpoint_root: &Path, index: &CheckpointIndex) -> std::io::Result<()> {
    let index_path = checkpoint_root.join(INDEX_FILE);
    let tmp = format!("{}.tmp.{}", index_path.display(), timestamp_millis());
    let content = serde_json::to_string_pretty(index)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    fs::write(&tmp, format!("{content}\n")).await?;
    fs::rename(&tmp, &index_path).await?;
    Ok(())
}

async fn load_manifest(checkpoint_root: &Path, checkpoint_id: &str) -> Option<CheckpointManifest> {
    let manifest_path = checkpoint_root.join(MANIFESTS_DIR).join(format!("{checkpoint_id}.json"));
    let content = fs::read_to_string(&manifest_path).await.ok()?;
    serde_json::from_str(&content).ok()
}

async fn save_manifest(
    checkpoint_root: &Path,
    checkpoint_id: &str,
    manifest: &CheckpointManifest,
) -> std::io::Result<()> {
    let manifest_path = checkpoint_root.join(MANIFESTS_DIR).join(format!("{checkpoint_id}.json"));
    let tmp = format!("{}.tmp.{}", manifest_path.display(), timestamp_millis());
    let content = serde_json::to_string(manifest)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    fs::write(&tmp, content).await?;
    fs::rename(&tmp, &manifest_path).await?;
    Ok(())
}

async fn prune_and_gc(
    checkpoint_root: &Path,
    index: &mut CheckpointIndex,
    max_checkpoints: usize,
) {
    if index.checkpoints.len() <= max_checkpoints {
        return;
    }

    let excess = index.checkpoints.len() - max_checkpoints;
    let removed: Vec<TurnCheckpoint> = index.checkpoints.drain(..excess).collect();

    // Collect hashes still referenced
    let mut referenced: HashSet<String> = HashSet::new();
    for cp in &index.checkpoints {
        if let Some(manifest) = load_manifest(checkpoint_root, &cp.id).await {
            for entry in manifest.files.values() {
                referenced.insert(entry.hash.clone());
            }
        }
    }

    // Delete manifests and orphaned blobs
    for cp in &removed {
        if let Some(manifest) = load_manifest(checkpoint_root, &cp.id).await {
            // Delete manifest
            let mp = checkpoint_root.join(MANIFESTS_DIR).join(format!("{}.json", cp.id));
            let _ = fs::remove_file(&mp).await;
            // Delete orphaned blobs
            for entry in manifest.files.values() {
                if !referenced.contains(&entry.hash) {
                    let bp = blob_path(checkpoint_root, &entry.hash);
                    let _ = fs::remove_file(&bp).await;
                }
            }
        }
    }
}

fn manifests_equal(a: &CheckpointManifest, b: &CheckpointManifest) -> bool {
    if a.files.len() != b.files.len() {
        return false;
    }
    let mut keys_a: Vec<&String> = a.files.keys().collect();
    let mut keys_b: Vec<&String> = b.files.keys().collect();
    keys_a.sort();
    keys_b.sort();
    for (ka, kb) in keys_a.iter().zip(keys_b.iter()) {
        if ka != kb {
            return false;
        }
        if a.files[*ka].hash != b.files[*kb].hash {
            return false;
        }
    }
    true
}

fn build_diff_summary(old: &CheckpointManifest, new: &CheckpointManifest) -> String {
    let mut all_paths: Vec<&String> = old.files.keys().chain(new.files.keys()).collect();
    all_paths.sort();
    all_paths.dedup();

    let mut lines = Vec::new();
    for p in &all_paths {
        let old_entry = old.files.get(*p);
        let new_entry = new.files.get(*p);
        match (old_entry, new_entry) {
            (None, Some(_)) => lines.push(format!("A {p}")),
            (Some(_), None) => lines.push(format!("D {p}")),
            (Some(a), Some(b)) if a.hash != b.hash => lines.push(format!("M {p}")),
            _ => {}
        }
    }

    if lines.is_empty() {
        "(no changes)".to_string()
    } else {
        lines.join("\n")
    }
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

fn truncate_message(message: &str, max_length: usize) -> String {
    let single_line = message
        .replace('\n', " ")
        .replace('\r', "")
        .trim()
        .to_string();
    if single_line.len() <= max_length {
        single_line
    } else {
        format!("{}...", &single_line[..max_length])
    }
}

fn now_iso() -> String {
    use std::time::SystemTime;
    let duration = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    let millis = duration.subsec_millis();

    let secs_per_day: u64 = 86400;
    let mut days = secs / secs_per_day;
    let day_secs = (secs % secs_per_day) as u32;
    let hours = day_secs / 3600;
    let minutes = (day_secs % 3600) / 60;
    let seconds = day_secs % 60;

    let mut year: u32 = 1970;
    loop {
        let yd = if is_leap(year) { 366u64 } else { 365 };
        if days < yd { break; }
        days -= yd;
        year += 1;
    }

    let md = if is_leap(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut month: u32 = 1;
    for &d in &md {
        if days < d { break; }
        days -= d;
        month += 1;
    }
    let day = days as u32 + 1;

    format!(
        "{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z"
    )
}

fn is_leap(year: u32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

fn timestamp_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_create_and_list_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        // Create a file in workspace
        fs::write(dir.path().join("hello.txt"), "world").await.unwrap();

        let args = CheckpointCreateArgs {
            turn_id: "turn-1".to_string(),
            turn_index: 0,
            user_message: "first message".to_string(),
            max_checkpoints: None,
        };
        let resp = create_checkpoint(args, workspace).await;
        assert!(resp.ok, "Error: {:?}", resp.error);

        // List
        let list_resp = list_checkpoints(workspace).await;
        assert!(list_resp.ok);
        let cps: Vec<TurnCheckpoint> = serde_json::from_value(list_resp.data.unwrap()).unwrap();
        assert_eq!(cps.len(), 1);
        assert_eq!(cps[0].id, "turn-1");
    }

    #[tokio::test]
    async fn test_restore_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let file_path = dir.path().join("data.txt");

        // Create initial file and checkpoint
        fs::write(&file_path, "original").await.unwrap();
        let args = CheckpointCreateArgs {
            turn_id: "cp-1".to_string(),
            turn_index: 0,
            user_message: "checkpoint 1".to_string(),
            max_checkpoints: None,
        };
        let resp = create_checkpoint(args, workspace).await;
        assert!(resp.ok);

        // Modify file
        fs::write(&file_path, "modified").await.unwrap();

        // Restore
        let restore_args = CheckpointRestoreArgs {
            turn_id: "cp-1".to_string(),
        };
        let restore_resp = restore_checkpoint(restore_args, workspace).await;
        assert!(restore_resp.ok, "Error: {:?}", restore_resp.error);

        // Verify content restored
        let content = fs::read_to_string(&file_path).await.unwrap();
        assert_eq!(content, "original");
    }

    #[tokio::test]
    async fn test_manifest_dedup() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        fs::write(dir.path().join("file.txt"), "same").await.unwrap();

        // Create first checkpoint
        let args1 = CheckpointCreateArgs {
            turn_id: "cp-a".to_string(),
            turn_index: 0,
            user_message: "msg 1".to_string(),
            max_checkpoints: None,
        };
        create_checkpoint(args1, workspace).await;

        // Create second without changes → should return existing
        let args2 = CheckpointCreateArgs {
            turn_id: "cp-b".to_string(),
            turn_index: 1,
            user_message: "msg 2".to_string(),
            max_checkpoints: None,
        };
        let resp = create_checkpoint(args2, workspace).await;
        assert!(resp.ok);
        let data = resp.data.unwrap();
        // Should return the first checkpoint since content is identical
        assert_eq!(data["id"], "cp-a");
    }

    #[tokio::test]
    async fn test_diff_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let file_path = dir.path().join("code.rs");

        fs::write(&file_path, "fn main() {}").await.unwrap();
        let args = CheckpointCreateArgs {
            turn_id: "diff-cp".to_string(),
            turn_index: 0,
            user_message: "before change".to_string(),
            max_checkpoints: None,
        };
        create_checkpoint(args, workspace).await;

        // Modify
        fs::write(&file_path, "fn main() { println!(\"hello\"); }").await.unwrap();
        // Add new file
        fs::write(dir.path().join("new.txt"), "new").await.unwrap();

        let resp = diff_checkpoint("diff-cp", workspace).await;
        assert!(resp.ok);
        let data = resp.data.unwrap();
        let diff_str = data["diff"].as_str().unwrap();
        assert!(diff_str.contains("M code.rs"));
        assert!(diff_str.contains("A new.txt"));
    }

    #[tokio::test]
    async fn test_prune_gc() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        // Create 3 checkpoints with maxCheckpoints=2
        for i in 0..3 {
            fs::write(dir.path().join("data.txt"), format!("version {i}")).await.unwrap();
            let args = CheckpointCreateArgs {
                turn_id: format!("cp-{i}"),
                turn_index: i,
                user_message: format!("msg {i}"),
                max_checkpoints: Some(2),
            };
            create_checkpoint(args, workspace).await;
        }

        // Should only have 2 checkpoints remaining
        let list_resp = list_checkpoints(workspace).await;
        let cps: Vec<TurnCheckpoint> = serde_json::from_value(list_resp.data.unwrap()).unwrap();
        assert_eq!(cps.len(), 2);
        assert_eq!(cps[0].id, "cp-1");
        assert_eq!(cps[1].id, "cp-2");
    }

    #[tokio::test]
    async fn test_update_tool_calls() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        fs::write(dir.path().join("f.txt"), "x").await.unwrap();

        let args = CheckpointCreateArgs {
            turn_id: "tc-1".to_string(),
            turn_index: 0,
            user_message: "test".to_string(),
            max_checkpoints: None,
        };
        create_checkpoint(args, workspace).await;

        update_tool_calls("tc-1", vec!["read".into(), "write".into()], workspace).await;

        let list_resp = list_checkpoints(workspace).await;
        let cps: Vec<TurnCheckpoint> = serde_json::from_value(list_resp.data.unwrap()).unwrap();
        assert_eq!(cps[0].tool_calls, vec!["read", "write"]);
    }

    #[tokio::test]
    async fn test_collect_files_excludes() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".git")).await.unwrap();
        fs::write(dir.path().join(".git").join("config"), "x").await.unwrap();
        fs::create_dir_all(dir.path().join("node_modules")).await.unwrap();
        fs::write(dir.path().join("node_modules").join("pkg.json"), "{}").await.unwrap();
        fs::write(dir.path().join("main.ts"), "code").await.unwrap();

        let files = collect_files(dir.path(), WORKSPACE_EXCLUDES).await;
        assert_eq!(files.len(), 1);
        assert!(files[0].contains("main.ts"));
    }

    #[tokio::test]
    async fn test_empty_workspace_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        let args = CheckpointCreateArgs {
            turn_id: "empty-1".to_string(),
            turn_index: 0,
            user_message: "empty ws".to_string(),
            max_checkpoints: None,
        };
        let resp = create_checkpoint(args, workspace).await;
        assert!(resp.ok);
    }
}
