//! edit.rs — Edit tool implementation (unified diff patch applier).
//!
//! Mirrors the core logic from TypeScript's EditTool. Parses a unified diff,
//! applies hunks to the target file, backs up, and writes atomically.

use tokio::fs;
use tool_protocol::{EditArgs, EditResult, ToolResponse};
use tool_fs::{resolve_safe_path, assert_inside_workspace};

use crate::backup;
use crate::atomic;
use crate::diff;

/// Execute an edit operation: apply a unified diff to a file.
pub async fn execute_edit(args: EditArgs, workspace_root: &str) -> ToolResponse {
    // 1. Resolve path
    let absolute_path = match resolve_safe_path(&args.target_file, workspace_root) {
        Ok(p) => p,
        Err(e) => {
            return ToolResponse::failure(format!(
                "Invalid targetFile path: {e} Ensure targetFile points to a file inside the current workspace root."
            ));
        }
    };
    if let Err(e) = assert_inside_workspace(&absolute_path, workspace_root) {
        return ToolResponse::failure(format!(
            "Invalid targetFile path: {e} Ensure targetFile points to a file inside the current workspace root."
        ));
    }

    let abs_str = absolute_path.to_string_lossy().to_string();

    // 2. Read original content
    let original_content = match fs::read_to_string(&absolute_path).await {
        Ok(c) => c,
        Err(_) => {
            return ToolResponse::failure(format!("File not found or unreadable: {abs_str}"));
        }
    };

    // 3. Parse unified diff
    let hunks = diff::parse_unified_diff(&args.diff);
    if hunks.is_empty() {
        if !diff::looks_like_unified_diff(&args.diff) {
            return ToolResponse::failure(
                "Diff format is invalid. Expected unified diff with @@ hunk headers (e.g. @@ -1,3 +1,4 @@). \
                 Hunk body lines must start with ' ' (context), '-' (remove), or '+' (add)."
                    .to_string(),
            );
        }
        return ToolResponse::failure(
            "No valid unified diff hunks found. Ensure each hunk has a valid @@ -oldStart,oldCount +newStart,newCount @@ header \
             and body lines that start with ' ', '-' or '+'."
                .to_string(),
        );
    }

    // 4. Apply hunks (sorted by original_start descending)
    let fuzz = args.fuzz.map(|f| f.min(5)).unwrap_or(2);
    let mut lines = diff::split_preserve_empty_last_line(&original_content);

    // Normalize \r\n → \n (already done by read_to_string on most platforms,
    // but the split-based approach handles it)
    // Remove any trailing \r from lines
    for line in &mut lines {
        if line.ends_with('\r') {
            line.truncate(line.len() - 1);
        }
    }

    let mut sorted_hunks: Vec<_> = hunks.iter().collect();
    sorted_hunks.sort_by(|a, b| b.original_start.cmp(&a.original_start));

    for hunk in &sorted_hunks {
        let m = diff::find_hunk_position(&lines, hunk, fuzz);
        if !m.found {
            let mismatch = diff::describe_hunk_mismatch(&lines, hunk);
            let mismatch_hint = if let Some(mm) = mismatch {
                format!(
                    " Mismatch near file line {}: expected {} but found {}.",
                    mm.line,
                    diff::quote_for_error(&mm.expected),
                    diff::quote_for_error(&mm.actual)
                )
            } else {
                String::new()
            };
            return ToolResponse::failure(format!(
                "Hunk failed to match near original line {}.{} \
                 Re-read the target file and regenerate the diff with exact context lines.",
                hunk.original_start, mismatch_hint
            ));
        }
        diff::apply_hunk(&mut lines, hunk, m.offset);
    }

    // 5. Check for noop
    let new_content = diff::join_preserve_empty_last_line(&lines);
    if new_content == original_content {
        let result = EditResult {
            path: abs_str.clone(),
            hunks_applied: hunks.len(),
            lines_changed: diff::count_changed_lines(&hunks),
            message: Some("Diff applied with no resulting content change.".to_string()),
        };
        return match serde_json::to_value(&result) {
            Ok(v) => ToolResponse::success(v),
            Err(e) => ToolResponse::failure(format!("Serialization error: {e}")),
        };
    }

    // 6. Backup original file
    if let Err(e) = backup::backup_file(&absolute_path, workspace_root).await {
        return ToolResponse::failure(format!("Backup failed: {e}"));
    }

    // 7. Atomic write new content
    if let Err(e) = atomic::atomic_write_text_file(&absolute_path, &new_content).await {
        return ToolResponse::failure(format!(
            "Failed to write updated content to {abs_str}: {e}"
        ));
    }

    let result = EditResult {
        path: abs_str,
        hunks_applied: hunks.len(),
        lines_changed: diff::count_changed_lines(&hunks),
        message: None,
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
    async fn test_edit_single_hunk() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let file_path = dir.path().join("test.txt");
        fs::write(&file_path, "line 1\nline 2\nline 3\n").await.unwrap();

        let diff_text = "@@ -1,3 +1,3 @@\n line 1\n-line 2\n+line TWO\n line 3\n";
        let args = EditArgs {
            target_file: "test.txt".to_string(),
            diff: diff_text.to_string(),
            fuzz: None,
        };
        let resp = execute_edit(args, workspace).await;
        assert!(resp.ok, "Error: {:?}", resp.error);

        let content = fs::read_to_string(&file_path).await.unwrap();
        assert!(content.contains("line TWO"));
        assert!(!content.contains("line 2"));
    }

    #[tokio::test]
    async fn test_edit_multiple_hunks() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let file_path = dir.path().join("multi.txt");
        let original = (1..=10).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        fs::write(&file_path, &original).await.unwrap();

        let diff_text = "\
@@ -2,1 +2,1 @@
-line 2
+line TWO
@@ -8,1 +8,1 @@
-line 8
+line EIGHT";
        let args = EditArgs {
            target_file: "multi.txt".to_string(),
            diff: diff_text.to_string(),
            fuzz: None,
        };
        let resp = execute_edit(args, workspace).await;
        assert!(resp.ok, "Error: {:?}", resp.error);

        let data = resp.data.unwrap();
        assert_eq!(data["hunksApplied"], 2);

        let content = fs::read_to_string(&file_path).await.unwrap();
        assert!(content.contains("line TWO"));
        assert!(content.contains("line EIGHT"));
    }

    #[tokio::test]
    async fn test_edit_fuzz_offset() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let file_path = dir.path().join("fuzz.txt");
        // File has an extra line at the top compared to what the diff expects
        fs::write(&file_path, "extra header\nalpha\nbeta\ngamma\n").await.unwrap();

        // Diff claims beta is at line 2, but it's actually at line 3
        let diff_text = "@@ -2,1 +2,1 @@\n-beta\n+BETA";
        let args = EditArgs {
            target_file: "fuzz.txt".to_string(),
            diff: diff_text.to_string(),
            fuzz: Some(2),
        };
        let resp = execute_edit(args, workspace).await;
        assert!(resp.ok, "Error: {:?}", resp.error);

        let content = fs::read_to_string(&file_path).await.unwrap();
        assert!(content.contains("BETA"));
    }

    #[tokio::test]
    async fn test_edit_match_failure() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let file_path = dir.path().join("fail.txt");
        fs::write(&file_path, "apple\nbanana\ncherry\n").await.unwrap();

        // Diff expects "wrong content" which doesn't exist
        let diff_text = "@@ -1,1 +1,1 @@\n-wrong content\n+replaced";
        let args = EditArgs {
            target_file: "fail.txt".to_string(),
            diff: diff_text.to_string(),
            fuzz: Some(0),
        };
        let resp = execute_edit(args, workspace).await;
        assert!(!resp.ok);
        assert!(resp.error.unwrap().contains("Hunk failed to match"));
    }

    #[tokio::test]
    async fn test_edit_noop() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let file_path = dir.path().join("noop.txt");
        fs::write(&file_path, "line 1\nline 2\n").await.unwrap();

        // Diff that removes and re-adds the same line → noop
        let diff_text = "@@ -2,1 +2,1 @@\n-line 2\n+line 2";
        let args = EditArgs {
            target_file: "noop.txt".to_string(),
            diff: diff_text.to_string(),
            fuzz: None,
        };
        let resp = execute_edit(args, workspace).await;
        assert!(resp.ok);

        let data = resp.data.unwrap();
        assert!(data["message"].as_str().unwrap().contains("no resulting content change"));
    }

    #[tokio::test]
    async fn test_edit_file_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        let args = EditArgs {
            target_file: "nonexistent.txt".to_string(),
            diff: "@@ -1,1 +1,1 @@\n-a\n+b".to_string(),
            fuzz: None,
        };
        let resp = execute_edit(args, workspace).await;
        assert!(!resp.ok);
        assert!(resp.error.unwrap().contains("not found"));
    }
}
