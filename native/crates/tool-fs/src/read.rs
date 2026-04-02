//! Read tool: read file contents with line numbers and pagination.
//! Mirrors src/tools/read.ts behaviour.

use std::path::Path;
use tokio::fs;
use tool_protocol::{ReadArgs, ReadMetadata, ReadFileInfo, ReadResult, ToolError, ToolResponse};

use crate::path_utils::{assert_inside_workspace, resolve_safe_path};

const MAX_LIMIT: u64 = 2000;

pub async fn execute_read(args: ReadArgs, workspace_root: &str) -> ToolResponse {
    match do_read(args, workspace_root).await {
        Ok(resp) => resp,
        Err(e) => e.into(),
    }
}

async fn do_read(args: ReadArgs, workspace_root: &str) -> Result<ToolResponse, ToolError> {
    let absolute_path = resolve_safe_path(&args.path, workspace_root)?;
    assert_inside_workspace(&absolute_path, workspace_root)?;

    let offset = args.offset.unwrap_or(0) as usize;
    let limit = args.limit.map(|l| l.clamp(1, MAX_LIMIT));

    let meta = fs::metadata(&absolute_path).await.map_err(|_| {
        ToolError::FileNotFound(absolute_path.display().to_string())
    })?;

    if !meta.is_file() {
        return Err(ToolError::FileNotFound(absolute_path.display().to_string()));
    }

    let text = fs::read_to_string(&absolute_path).await.map_err(ToolError::Io)?;
    let lines: Vec<&str> = text.split('\n')
        .collect::<Vec<_>>();

    // Handle \r\n by stripping trailing \r
    let lines: Vec<String> = lines.iter().map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect();

    let safe_offset = offset.min(lines.len());
    let end_exclusive = match limit {
        Some(l) => (safe_offset + l as usize).min(lines.len()),
        None => lines.len(),
    };

    let selected = &lines[safe_offset..end_exclusive];
    let content_lines: Vec<String> = selected
        .iter()
        .enumerate()
        .map(|(i, line)| format!("{}: {}", safe_offset + i + 1, line))
        .collect();

    let has_more = end_exclusive < lines.len();
    let next_offset = if has_more { Some(end_exclusive) } else { None };

    let viewed_range = if selected.is_empty() {
        format!("{}-{}", safe_offset + 1, safe_offset + 1)
    } else {
        format!("{}-{}", safe_offset + 1, end_exclusive)
    };

    let abs_str = absolute_path.display().to_string();
    let content = format!("=== File: {} ===\n{}", abs_str, content_lines.join("\n"));

    let result = ReadResult {
        content,
        file: ReadFileInfo {
            path: abs_str,
            content: content_lines.join("\n"),
        },
        metadata: ReadMetadata {
            total_lines: lines.len(),
            file_size: meta.len(),
            offset: safe_offset,
            limit,
            returned_lines: selected.len(),
            viewed_range,
            has_more,
            next_offset,
        },
    };

    Ok(ToolResponse::success(serde_json::to_value(result).unwrap()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs as std_fs;
    use tempfile::TempDir;

    fn setup_file(dir: &TempDir, name: &str, content: &str) -> String {
        let p = dir.path().join(name);
        if let Some(parent) = p.parent() {
            std_fs::create_dir_all(parent).unwrap();
        }
        std_fs::write(&p, content).unwrap();
        dir.path().display().to_string()
    }

    #[tokio::test]
    async fn test_read_full_file() {
        let dir = TempDir::new().unwrap();
        let ws = setup_file(&dir, "test.txt", "line1\nline2\nline3\nline4\nline5");
        let args = ReadArgs { path: "test.txt".into(), offset: None, limit: None };
        let resp = execute_read(args, &ws).await;
        assert!(resp.ok);
        let data: ReadResult = serde_json::from_value(resp.data.unwrap()).unwrap();
        assert_eq!(data.metadata.total_lines, 5);
        assert_eq!(data.metadata.returned_lines, 5);
        assert!(!data.metadata.has_more);
        assert_eq!(data.metadata.viewed_range, "1-5");
    }

    #[tokio::test]
    async fn test_read_with_pagination() {
        let dir = TempDir::new().unwrap();
        let ws = setup_file(&dir, "test.txt", "a\nb\nc\nd");
        let args = ReadArgs { path: "test.txt".into(), offset: Some(1), limit: Some(2) };
        let resp = execute_read(args, &ws).await;
        assert!(resp.ok);
        let data: ReadResult = serde_json::from_value(resp.data.unwrap()).unwrap();
        assert_eq!(data.metadata.offset, 1);
        assert_eq!(data.metadata.limit, Some(2));
        assert_eq!(data.metadata.returned_lines, 2);
        assert!(data.metadata.has_more);
        assert_eq!(data.metadata.next_offset, Some(3));
        assert_eq!(data.metadata.viewed_range, "2-3");
    }

    #[tokio::test]
    async fn test_read_missing_file() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path().display().to_string();
        let args = ReadArgs { path: "nonexistent.txt".into(), offset: None, limit: None };
        let resp = execute_read(args, &ws).await;
        assert!(!resp.ok);
        let err = resp.error.as_ref().unwrap();
        assert!(err.contains("not found") || err.contains("File not found"));
    }

    #[tokio::test]
    async fn test_read_outside_workspace() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path().display().to_string();
        let args = ReadArgs { path: "../../etc/passwd".into(), offset: None, limit: None };
        let resp = execute_read(args, &ws).await;
        assert!(!resp.ok);
    }
}
