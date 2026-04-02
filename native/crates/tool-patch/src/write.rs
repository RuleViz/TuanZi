//! write.rs — Write tool implementation.
//!
//! Mirrors the core file-writing logic from TypeScript's WriteTool.
//! Policy checks and approval are handled by the TS layer before
//! this code is invoked.

use tokio::fs;
use tool_protocol::{ToolResponse, WriteArgs, WriteResult};
use tool_fs::{resolve_safe_path, assert_inside_workspace};

use crate::backup;
use crate::atomic;

/// Execute a write operation: full file content replacement.
///
/// Steps:
///   1. Resolve and validate path within workspace
///   2. Read previous content (if any) for backup
///   3. Backup existing file
///   4. Atomic write new content
pub async fn execute_write(args: WriteArgs, workspace_root: &str) -> ToolResponse {
    // 1. Resolve path
    let absolute_path = match resolve_safe_path(&args.path, workspace_root) {
        Ok(p) => p,
        Err(e) => return ToolResponse::failure(format!("Invalid path: {e}")),
    };
    if let Err(e) = assert_inside_workspace(&absolute_path, workspace_root) {
        return ToolResponse::failure(e.to_string());
    }

    // 2. Check if file already exists (for backup)
    let previous_exists = fs::metadata(&absolute_path).await.map(|m| m.is_file()).unwrap_or(false);

    // 3. Backup if file exists
    let backup_path = if previous_exists {
        match backup::backup_file(&absolute_path, workspace_root).await {
            Ok(bp) => bp,
            Err(e) => return ToolResponse::failure(format!("Backup failed: {e}")),
        }
    } else {
        None
    };

    // 4. Atomic write
    if let Err(e) = atomic::atomic_write_text_file(&absolute_path, &args.content).await {
        return ToolResponse::failure(format!("Write failed: {e}"));
    }

    let bytes_written = args.content.len() as u64;
    let abs_str = absolute_path.to_string_lossy().to_string();

    let result = WriteResult {
        path: abs_str,
        bytes_written,
        backup_path,
    };

    match serde_json::to_value(&result) {
        Ok(v) => ToolResponse::success(v),
        Err(e) => ToolResponse::failure(format!("Serialization error: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_write_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let file_rel = "new_file.txt";

        let args = WriteArgs {
            path: file_rel.to_string(),
            content: "hello world".to_string(),
        };
        let resp = execute_write(args, workspace).await;
        assert!(resp.ok);

        let data = resp.data.unwrap();
        assert_eq!(data["bytesWritten"], 11);
        assert!(data["backupPath"].is_null());

        let content = fs::read_to_string(dir.path().join(file_rel)).await.unwrap();
        assert_eq!(content, "hello world");
    }

    #[tokio::test]
    async fn test_write_overwrite_with_backup() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let file_path = dir.path().join("existing.txt");
        fs::write(&file_path, "old content").await.unwrap();

        let args = WriteArgs {
            path: "existing.txt".to_string(),
            content: "new content".to_string(),
        };
        let resp = execute_write(args, workspace).await;
        assert!(resp.ok);

        let data = resp.data.unwrap();
        assert!(!data["backupPath"].is_null());

        let content = fs::read_to_string(&file_path).await.unwrap();
        assert_eq!(content, "new content");
    }

    #[tokio::test]
    async fn test_write_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        let args = WriteArgs {
            path: "a/b/c/deep.txt".to_string(),
            content: "deep content".to_string(),
        };
        let resp = execute_write(args, workspace).await;
        assert!(resp.ok);

        let content = fs::read_to_string(dir.path().join("a/b/c/deep.txt")).await.unwrap();
        assert_eq!(content, "deep content");
    }

    #[tokio::test]
    async fn test_write_outside_workspace_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("sub").to_str().unwrap().to_string();
        fs::create_dir_all(&workspace).await.unwrap();

        let args = WriteArgs {
            path: "../escape.txt".to_string(),
            content: "bad".to_string(),
        };
        let resp = execute_write(args, &workspace).await;
        assert!(!resp.ok);
        let err = resp.error.as_ref().unwrap();
        assert!(err.to_lowercase().contains("outside"));
    }
}
