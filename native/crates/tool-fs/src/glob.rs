//! Glob tool: recursively find files/directories by glob pattern.
//! Mirrors src/tools/glob.ts behaviour.

use std::path::{Path, PathBuf};
use tokio::fs;
use tool_protocol::{GlobArgs, GlobMatch, GlobResult, ToolError, ToolResponse};

use crate::path_utils::{assert_inside_workspace, relative_from_workspace, resolve_safe_path, to_unix_path};

const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", ".tuanzi", ".npm-cache", "dist", "build", ".idea", ".vscode",
];

pub async fn execute_glob(args: GlobArgs, workspace_root: &str) -> ToolResponse {
    match do_glob(args, workspace_root).await {
        Ok(resp) => resp,
        Err(e) => e.into(),
    }
}

async fn do_glob(args: GlobArgs, workspace_root: &str) -> Result<ToolResponse, ToolError> {
    let root_path = resolve_safe_path(&args.search_path, workspace_root)?;
    assert_inside_workspace(&root_path, workspace_root)?;

    let max_results = args.max_results.map(|m| m.clamp(1, 200) as usize);
    let max_depth = args.max_depth.unwrap_or(30).clamp(0, 200) as usize;
    let matcher = glob_to_regex(&args.pattern);

    let meta = fs::metadata(&root_path).await.map_err(|_| {
        ToolError::DirectoryNotFound(format!("search_path is not a directory: {}", root_path.display()))
    })?;
    if !meta.is_dir() {
        return Err(ToolError::DirectoryNotFound(format!(
            "search_path is not a directory: {}",
            root_path.display()
        )));
    }

    let mut matches: Vec<GlobMatch> = Vec::new();
    let mut truncated = false;
    walk(&root_path, &root_path, 0, max_depth, &matcher, max_results, &mut matches, &mut truncated).await;

    let result = GlobResult {
        search_path: root_path.display().to_string(),
        pattern: args.pattern,
        total: matches.len(),
        truncated,
        matches,
    };

    Ok(ToolResponse::success(serde_json::to_value(result).unwrap()))
}

async fn walk(
    root_path: &Path,
    current_path: &Path,
    depth: usize,
    max_depth: usize,
    matcher: &regex::Regex,
    max_results: Option<usize>,
    matches: &mut Vec<GlobMatch>,
    truncated: &mut bool,
) {
    if depth > max_depth {
        return;
    }
    if let Some(max) = max_results {
        if matches.len() >= max {
            return;
        }
    }

    let mut dir = match fs::read_dir(current_path).await {
        Ok(d) => d,
        Err(_) => return,
    };

    let mut entries: Vec<(PathBuf, String, bool)> = Vec::new();
    while let Ok(Some(entry)) = dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        let file_type = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let is_dir = file_type.is_dir();

        if is_dir && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }

        entries.push((entry.path(), name, is_dir));
    }

    for (abs_path, name, is_dir) in &entries {
        if let Some(max) = max_results {
            if matches.len() >= max {
                *truncated = true;
                return;
            }
        }

        let relative = to_unix_path(
            &abs_path
                .strip_prefix(root_path)
                .unwrap_or(abs_path)
                .display()
                .to_string(),
        );

        if matcher.is_match(&relative) || matcher.is_match(name) {
            let size_bytes = if *is_dir {
                0
            } else {
                fs::metadata(abs_path).await.map(|m| m.len()).unwrap_or(0)
            };

            matches.push(GlobMatch {
                absolute_path: abs_path.display().to_string(),
                relative_path: relative_from_workspace(abs_path, root_path),
                is_directory: *is_dir,
                size_bytes,
            });
        }

        if *is_dir {
            Box::pin(walk(root_path, abs_path, depth + 1, max_depth, matcher, max_results, matches, truncated)).await;
        }
    }
}

/// Convert a glob pattern to a regex, matching TS `globToRegExp()`.
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

    regex::Regex::new(&format!("(?i)^{final_pattern}$")).unwrap_or_else(|_| {
        regex::Regex::new("^$").unwrap()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs as std_fs;
    use tempfile::TempDir;

    fn setup_tree(dir: &TempDir) -> String {
        std_fs::create_dir_all(dir.path().join("src/nested")).unwrap();
        std_fs::write(dir.path().join("src/index.ts"), "export {};").unwrap();
        std_fs::write(dir.path().join("src/util.ts"), "util").unwrap();
        std_fs::write(dir.path().join("src/nested/deep.ts"), "deep").unwrap();
        std_fs::write(dir.path().join("readme.md"), "# Hi").unwrap();
        dir.path().display().to_string()
    }

    #[tokio::test]
    async fn test_glob_find_ts_files() {
        let dir = TempDir::new().unwrap();
        let ws = setup_tree(&dir);
        let args = GlobArgs {
            search_path: ".".into(),
            pattern: "*.ts".into(),
            max_results: None,
            max_depth: None,
        };
        let resp = execute_glob(args, &ws).await;
        assert!(resp.ok);
        let data: GlobResult = serde_json::from_value(resp.data.unwrap()).unwrap();
        assert!(data.matches.len() >= 3);
        for m in &data.matches {
            assert!(m.absolute_path.ends_with(".ts"));
            assert!(!m.is_directory);
        }
    }

    #[tokio::test]
    async fn test_glob_max_results() {
        let dir = TempDir::new().unwrap();
        let ws = setup_tree(&dir);
        let args = GlobArgs {
            search_path: ".".into(),
            pattern: "*.ts".into(),
            max_results: Some(1),
            max_depth: None,
        };
        let resp = execute_glob(args, &ws).await;
        assert!(resp.ok);
        let data: GlobResult = serde_json::from_value(resp.data.unwrap()).unwrap();
        assert_eq!(data.matches.len(), 1);
        assert!(data.truncated);
    }

    #[tokio::test]
    async fn test_glob_nonexistent_dir() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path().display().to_string();
        let args = GlobArgs {
            search_path: "no_such_dir".into(),
            pattern: "*".into(),
            max_results: None,
            max_depth: None,
        };
        let resp = execute_glob(args, &ws).await;
        assert!(!resp.ok);
    }
}
