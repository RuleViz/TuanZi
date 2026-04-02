//! Ls tool: list directory entries (non-recursive, single level).
//! Mirrors src/tools/ls.ts behaviour.

use std::path::Path;
use tokio::fs;
use tool_protocol::{LsArgs, LsEntry, LsResult, ToolError, ToolResponse};

use crate::path_utils::{assert_inside_workspace, resolve_safe_path};

const MAX_LIMIT: u64 = 2000;

pub async fn execute_ls(args: LsArgs, workspace_root: &str) -> ToolResponse {
    match do_ls(args, workspace_root).await {
        Ok(resp) => resp,
        Err(e) => e.into(),
    }
}

async fn do_ls(args: LsArgs, workspace_root: &str) -> Result<ToolResponse, ToolError> {
    let absolute_path = resolve_safe_path(&args.path, workspace_root)?;
    assert_inside_workspace(&absolute_path, workspace_root)?;

    let limit = args.limit.map(|l| l.clamp(1, MAX_LIMIT) as usize);
    let show_hidden = args.show_hidden.unwrap_or(false);
    let matcher = args.pattern.as_deref().map(glob_to_regex);

    let meta = fs::metadata(&absolute_path).await.map_err(|_| {
        ToolError::DirectoryNotFound(absolute_path.display().to_string())
    })?;
    if !meta.is_dir() {
        return Err(ToolError::DirectoryNotFound(absolute_path.display().to_string()));
    }

    let mut entries: Vec<LsEntry> = Vec::new();
    let mut truncated = false;

    let mut dir = fs::read_dir(&absolute_path).await.map_err(ToolError::Io)?;
    let mut raw_entries: Vec<(String, bool)> = Vec::new();

    while let Some(entry) = dir.next_entry().await.map_err(ToolError::Io)? {
        let name = entry.file_name().to_string_lossy().to_string();
        let file_type = entry.file_type().await.map_err(ToolError::Io)?;
        let is_dir = file_type.is_dir();

        if !show_hidden && name.starts_with('.') {
            continue;
        }

        let normalized = name.replace('\\', "/");
        let with_suffix = if is_dir { format!("{normalized}/") } else { normalized.clone() };

        if let Some(ref re) = matcher {
            if !re.is_match(&normalized) && !re.is_match(&with_suffix) {
                continue;
            }
        }

        if let Some(lim) = limit {
            if raw_entries.len() >= lim {
                truncated = true;
                break;
            }
        }

        raw_entries.push((normalized, is_dir));
    }

    // Sort: directories first, then alphabetical
    raw_entries.sort_by(|a, b| {
        b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0))
    });

    for (name, is_dir) in &raw_entries {
        entries.push(LsEntry {
            path: if *is_dir { format!("{name}/") } else { name.clone() },
            is_directory: *is_dir,
            depth: 1,
        });
    }

    let mut lines: Vec<String> = entries.iter().map(|e| e.path.clone()).collect();
    if truncated {
        if let Some(lim) = limit {
            lines.push(format!(
                "... output truncated: returned first {} entries. Narrow with pattern or path.",
                lim
            ));
        }
    }

    let result = LsResult {
        content: lines.join("\n"),
        total: entries.len(),
        truncated,
        entries,
    };

    Ok(ToolResponse::success(serde_json::to_value(result).unwrap()))
}

/// Convert a glob pattern to a regex, mirroring `globToRegExp()` in file-utils.ts.
fn glob_to_regex(pattern: &str) -> regex::Regex {
    let normalized = pattern.replace('\\', "/");
    let has_wildcard = normalized.contains('*') || normalized.contains('?');
    let wrapped = if has_wildcard {
        normalized
    } else {
        format!("*{normalized}*")
    };

    let marker = "__DOUBLE_STAR__";
    let with_marker = wrapped.replace("**", marker);
    let escaped = regex::escape(&with_marker);
    let single_star = escaped
        .replace(r"\*", "[^/]*")
        .replace(r"\?", ".");
    let final_pattern = single_star.replace(marker, ".*");

    // Case insensitive to match TS behaviour
    regex::Regex::new(&format!("(?i)^{final_pattern}$")).unwrap_or_else(|_| {
        regex::Regex::new("^$").unwrap()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs as std_fs;
    use tempfile::TempDir;

    fn setup_dir(dir: &TempDir) -> String {
        std_fs::create_dir_all(dir.path().join("src/nested")).unwrap();
        std_fs::write(dir.path().join("src/index.ts"), "export {};").unwrap();
        std_fs::write(dir.path().join("src/nested/deep.ts"), "deep").unwrap();
        std_fs::write(dir.path().join("readme.md"), "# Hi").unwrap();
        std_fs::write(dir.path().join(".hidden"), "secret").unwrap();
        dir.path().display().to_string()
    }

    #[tokio::test]
    async fn test_ls_basic() {
        let dir = TempDir::new().unwrap();
        let ws = setup_dir(&dir);
        let args = LsArgs { path: ".".into(), limit: None, show_hidden: None, pattern: None };
        let resp = execute_ls(args, &ws).await;
        assert!(resp.ok);
        let data: LsResult = serde_json::from_value(resp.data.unwrap()).unwrap();
        assert!(!data.entries.is_empty());
        // Hidden files should NOT appear by default
        assert!(!data.entries.iter().any(|e| e.path.contains(".hidden")));
        // Should NOT recurse into nested
        assert!(!data.entries.iter().any(|e| e.path.contains("deep")));
    }

    #[tokio::test]
    async fn test_ls_show_hidden() {
        let dir = TempDir::new().unwrap();
        let ws = setup_dir(&dir);
        let args = LsArgs { path: ".".into(), limit: None, show_hidden: Some(true), pattern: None };
        let resp = execute_ls(args, &ws).await;
        assert!(resp.ok);
        let data: LsResult = serde_json::from_value(resp.data.unwrap()).unwrap();
        assert!(data.entries.iter().any(|e| e.path.contains(".hidden")));
    }

    #[tokio::test]
    async fn test_ls_with_limit() {
        let dir = TempDir::new().unwrap();
        let ws = setup_dir(&dir);
        let args = LsArgs { path: ".".into(), limit: Some(1), show_hidden: None, pattern: None };
        let resp = execute_ls(args, &ws).await;
        assert!(resp.ok);
        let data: LsResult = serde_json::from_value(resp.data.unwrap()).unwrap();
        assert_eq!(data.entries.len(), 1);
        assert!(data.truncated);
    }

    #[tokio::test]
    async fn test_ls_nonexistent() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path().display().to_string();
        let args = LsArgs { path: "no_such_dir".into(), limit: None, show_hidden: None, pattern: None };
        let resp = execute_ls(args, &ws).await;
        assert!(!resp.ok);
    }
}
