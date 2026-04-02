//! delete.rs — Delete file/directory tool implementation.
//!
//! Mirrors the core logic from TypeScript's DeleteFileTool.

use tokio::fs;
use tool_protocol::{DeleteArgs, DeleteResult, ToolResponse};
use tool_fs::{resolve_safe_path, assert_inside_workspace};

use crate::backup;

/// Execute a delete operation on a file or empty directory.
pub async fn execute_delete(args: DeleteArgs, workspace_root: &str) -> ToolResponse {
    // 1. Resolve path
    let absolute_path = match resolve_safe_path(&args.path, workspace_root) {
        Ok(p) => p,
        Err(e) => return ToolResponse::failure(format!("Invalid path: {e}")),
    };
    if let Err(e) = assert_inside_workspace(&absolute_path, workspace_root) {
        return ToolResponse::failure(e.to_string());
    }

    let abs_str = absolute_path.to_string_lossy().to_string();

    // 2. Stat the target
    let metadata = match fs::metadata(&absolute_path).await {
        Ok(m) => m,
        Err(_) => {
            return ToolResponse::failure(format!("Path does not exist: {abs_str}"));
        }
    };

    let (entry_type, backup_path) = if metadata.is_file() {
        // 3a. File: backup then delete
        let bp = match backup::backup_file(&absolute_path, workspace_root).await {
            Ok(bp) => bp,
            Err(e) => return ToolResponse::failure(format!("Backup failed: {e}")),
        };
        if let Err(e) = fs::remove_file(&absolute_path).await {
            return ToolResponse::failure(format!("Failed to delete file: {e}"));
        }
        ("file".to_string(), bp)
    } else if metadata.is_dir() {
        // 3b. Directory: must be empty
        let mut entries = match fs::read_dir(&absolute_path).await {
            Ok(e) => e,
            Err(e) => return ToolResponse::failure(format!("Failed to read directory: {e}")),
        };
        if entries.next_entry().await.map(|e| e.is_some()).unwrap_or(false) {
            return ToolResponse::failure("Only empty directories can be deleted in MVP.".to_string());
        }
        if let Err(e) = fs::remove_dir(&absolute_path).await {
            return ToolResponse::failure(format!("Failed to delete directory: {e}"));
        }
        ("directory".to_string(), None)
    } else {
        return ToolResponse::failure("Unsupported file type for deletion.".to_string());
    };

    let result = DeleteResult {
        deleted_path: abs_str,
        entry_type,
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
    async fn test_delete_file_with_backup() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let file_path = dir.path().join("to_delete.txt");
        fs::write(&file_path, "content").await.unwrap();

        let args = DeleteArgs {
            path: "to_delete.txt".to_string(),
        };
        let resp = execute_delete(args, workspace).await;
        assert!(resp.ok, "Error: {:?}", resp.error);

        let data = resp.data.unwrap();
        assert_eq!(data["entryType"], "file");
        assert!(!data["backupPath"].is_null());

        // File should be gone
        assert!(!file_path.exists());
    }

    #[tokio::test]
    async fn test_delete_empty_directory() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let subdir = dir.path().join("empty_dir");
        fs::create_dir(&subdir).await.unwrap();

        let args = DeleteArgs {
            path: "empty_dir".to_string(),
        };
        let resp = execute_delete(args, workspace).await;
        assert!(resp.ok);

        let data = resp.data.unwrap();
        assert_eq!(data["entryType"], "directory");
        assert!(data["backupPath"].is_null());
        assert!(!subdir.exists());
    }

    #[tokio::test]
    async fn test_delete_nonempty_directory_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let subdir = dir.path().join("nonempty");
        fs::create_dir(&subdir).await.unwrap();
        fs::write(subdir.join("child.txt"), "data").await.unwrap();

        let args = DeleteArgs {
            path: "nonempty".to_string(),
        };
        let resp = execute_delete(args, workspace).await;
        assert!(!resp.ok);
        assert!(resp.error.unwrap().contains("empty directories"));
    }

    #[tokio::test]
    async fn test_delete_nonexistent() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        let args = DeleteArgs {
            path: "ghost.txt".to_string(),
        };
        let resp = execute_delete(args, workspace).await;
        assert!(!resp.ok);
        assert!(resp.error.unwrap().contains("does not exist"));
    }

    #[tokio::test]
    async fn test_delete_outside_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("sub").to_str().unwrap().to_string();
        fs::create_dir_all(&workspace).await.unwrap();

        let args = DeleteArgs {
            path: "../escape.txt".to_string(),
        };
        let resp = execute_delete(args, &workspace).await;
        assert!(!resp.ok);
    }
}
