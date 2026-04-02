//! Grep tool: search file contents by text/regex with context lines.
//! Mirrors src/tools/grep.ts behaviour.

use std::path::{Path, PathBuf};
use tokio::fs;
use tool_protocol::{GrepArgs, GrepHit, GrepResult, ToolError, ToolResponse};

use crate::path_utils::{assert_inside_workspace, resolve_safe_path};

const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", ".tuanzi", ".npm-cache", "dist", "build", ".idea", ".vscode",
];

const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024; // 2 MB

const BINARY_EXTENSIONS: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".pdf",
    ".zip", ".tar", ".gz", ".7z",
    ".mp3", ".mp4", ".mov",
    ".exe", ".dll", ".so", ".class", ".jar",
    ".woff", ".woff2",
];

pub async fn execute_grep(args: GrepArgs, workspace_root: &str) -> ToolResponse {
    match do_grep(args, workspace_root).await {
        Ok(resp) => resp,
        Err(e) => e.into(),
    }
}

async fn do_grep(args: GrepArgs, workspace_root: &str) -> Result<ToolResponse, ToolError> {
    let search_path = resolve_safe_path(&args.search_path, workspace_root)?;
    assert_inside_workspace(&search_path, workspace_root)?;

    let max_results = args.max_results.map(|m| m.clamp(1, 200) as usize);
    let context_lines = args.context_lines.unwrap_or(3).clamp(0, 10) as usize;
    let is_regex = args.is_regex.unwrap_or(false);
    let case_sensitive = args.case_sensitive.unwrap_or(false);

    let pattern_str = if is_regex {
        args.query.clone()
    } else {
        regex::escape(&args.query)
    };
    let flags = if case_sensitive { "" } else { "(?i)" };
    let regex = regex::Regex::new(&format!("{flags}{pattern_str}")).map_err(|e| {
        ToolError::InvalidRegex(e.to_string())
    })?;

    let include_matchers: Vec<regex::Regex> = args
        .includes
        .unwrap_or_default()
        .iter()
        .map(|p| glob_to_regex(p))
        .collect();

    let meta = fs::metadata(&search_path).await.map_err(|_| {
        ToolError::FileNotFound(format!("search_path does not exist: {}", search_path.display()))
    })?;

    let mut hits: Vec<GrepHit> = Vec::new();
    let mut truncated = false;

    if meta.is_file() {
        let file_hits = search_file(&search_path, &regex, context_lines, max_results, &mut truncated).await;
        hits.extend(file_hits);
    } else if meta.is_dir() {
        let gitignore_rules = load_gitignore_rules(&search_path).await;
        search_directory(
            &search_path,
            &search_path,
            &regex,
            &include_matchers,
            context_lines,
            &mut hits,
            max_results,
            &gitignore_rules,
            &mut truncated,
        )
        .await;
    } else {
        return Err(ToolError::Other("Unsupported search_path type.".into()));
    }

    let result = GrepResult {
        query: args.query,
        total: hits.len(),
        truncated,
        hits,
    };

    Ok(ToolResponse::success(serde_json::to_value(result).unwrap()))
}

async fn search_directory(
    root_path: &Path,
    current_path: &Path,
    regex: &regex::Regex,
    include_matchers: &[regex::Regex],
    context_lines: usize,
    hits: &mut Vec<GrepHit>,
    max_results: Option<usize>,
    gitignore_rules: &[GitignoreRule],
    truncated: &mut bool,
) {
    if let Some(max) = max_results {
        if hits.len() >= max {
            return;
        }
    }

    let mut dir = match fs::read_dir(current_path).await {
        Ok(d) => d,
        Err(_) => return,
    };

    let mut files: Vec<PathBuf> = Vec::new();
    let mut subdirs: Vec<PathBuf> = Vec::new();

    while let Ok(Some(entry)) = dir.next_entry().await {
        if let Some(max) = max_results {
            if hits.len() >= max {
                *truncated = true;
                return;
            }
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let file_type = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        if file_type.is_dir() && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }

        let abs_path = entry.path();
        let relative = abs_path
            .strip_prefix(root_path)
            .unwrap_or(&abs_path)
            .display()
            .to_string()
            .replace('\\', "/");

        if should_ignore_by_gitignore(&relative, file_type.is_dir(), gitignore_rules) {
            continue;
        }

        if file_type.is_dir() {
            subdirs.push(abs_path);
            continue;
        }

        if !looks_like_text_file(&name) {
            continue;
        }

        if !include_matchers.is_empty()
            && !include_matchers.iter().any(|m| m.is_match(&name) || m.is_match(&relative))
        {
            continue;
        }

        files.push(abs_path);
    }

    // Process files in batches of 10
    for chunk in files.chunks(10) {
        if let Some(max) = max_results {
            if hits.len() >= max {
                *truncated = true;
                return;
            }
        }
        let remaining = max_results.map(|m| m - hits.len());
        let mut handles = Vec::new();
        for file_path in chunk {
            let file_path = file_path.clone();
            let regex = regex.clone();
            handles.push(tokio::spawn(async move {
                search_file(&file_path, &regex, context_lines, remaining, &mut false).await
            }));
        }
        for handle in handles {
            if let Ok(file_hits) = handle.await {
                for hit in file_hits {
                    if let Some(max) = max_results {
                        if hits.len() >= max {
                            *truncated = true;
                            return;
                        }
                    }
                    hits.push(hit);
                }
            }
        }
    }

    for subdir in &subdirs {
        if let Some(max) = max_results {
            if hits.len() >= max {
                *truncated = true;
                return;
            }
        }
        Box::pin(search_directory(
            root_path, subdir, regex, include_matchers, context_lines, hits, max_results, gitignore_rules, truncated,
        ))
        .await;
    }
}

async fn search_file(
    file_path: &Path,
    regex: &regex::Regex,
    context_lines: usize,
    max_results: Option<usize>,
    truncated: &mut bool,
) -> Vec<GrepHit> {
    let mut hits: Vec<GrepHit> = Vec::new();

    let meta = match fs::metadata(file_path).await {
        Ok(m) => m,
        Err(_) => return hits,
    };
    if !meta.is_file() || meta.len() > MAX_FILE_SIZE {
        return hits;
    }

    let text = match fs::read_to_string(file_path).await {
        Ok(t) => t,
        Err(_) => return hits,
    };

    let lines: Vec<&str> = text.lines().collect();
    let file_str = file_path.display().to_string();

    for (index, line) in lines.iter().enumerate() {
        if let Some(max) = max_results {
            if hits.len() >= max {
                *truncated = true;
                return hits;
            }
        }

        if !regex.is_match(line) {
            continue;
        }

        let from = index.saturating_sub(context_lines);
        let to = (index + context_lines).min(lines.len().saturating_sub(1));
        let before: Vec<String> = lines[from..index].iter().map(|s| s.to_string()).collect();
        let after: Vec<String> = lines[(index + 1)..=to].iter().map(|s| s.to_string()).collect();

        hits.push(GrepHit {
            file: file_str.clone(),
            line_number: index + 1,
            line_content: line.to_string(),
            before,
            after,
        });
    }

    hits
}

fn looks_like_text_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    !BINARY_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

struct GitignoreRule {
    negative: bool,
    matcher: regex::Regex,
}

async fn load_gitignore_rules(search_root: &Path) -> Vec<GitignoreRule> {
    let gitignore_path = search_root.join(".gitignore");
    let text = match fs::read_to_string(&gitignore_path).await {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };

    let mut rules = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let negative = trimmed.starts_with('!');
        let raw = if negative { trimmed[1..].trim() } else { trimmed };
        if raw.is_empty() {
            continue;
        }
        rules.push(GitignoreRule {
            negative,
            matcher: glob_to_regex(raw),
        });
    }
    rules
}

fn should_ignore_by_gitignore(relative_path: &str, is_directory: bool, rules: &[GitignoreRule]) -> bool {
    if rules.is_empty() {
        return false;
    }
    let normalized = relative_path.replace('\\', "/");
    let candidate = if is_directory {
        format!("{normalized}/")
    } else {
        normalized.clone()
    };

    let mut ignored = false;
    for rule in rules {
        if rule.matcher.is_match(&candidate) || rule.matcher.is_match(&normalized) {
            ignored = !rule.negative;
        }
    }
    ignored
}

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
        std_fs::write(
            dir.path().join("src/index.ts"),
            "import { hello } from \"./util\";\n\nexport function main() {\n  console.log(hello(\"world\"));\n}\n",
        ).unwrap();
        std_fs::write(
            dir.path().join("src/util.ts"),
            "export function hello(name: string): string {\n  return `Hello, ${name}!`;\n}\n",
        ).unwrap();
        std_fs::write(dir.path().join("src/nested/deep.ts"), "export const DEEP_VALUE = 42;\nexport const DEEP_NAME = 'deep';\n").unwrap();
        std_fs::write(dir.path().join("readme.md"), "# Project\n\nThis is a test.").unwrap();
        dir.path().display().to_string()
    }

    #[tokio::test]
    async fn test_grep_plain_text() {
        let dir = TempDir::new().unwrap();
        let ws = setup_tree(&dir);
        let args = GrepArgs {
            search_path: ".".into(),
            query: "hello".into(),
            is_regex: None,
            case_sensitive: None,
            includes: None,
            max_results: None,
            context_lines: Some(1),
        };
        let resp = execute_grep(args, &ws).await;
        assert!(resp.ok);
        let data: GrepResult = serde_json::from_value(resp.data.unwrap()).unwrap();
        assert!(data.total > 0);
        assert_eq!(data.query, "hello");
    }

    #[tokio::test]
    async fn test_grep_regex() {
        let dir = TempDir::new().unwrap();
        let ws = setup_tree(&dir);
        let args = GrepArgs {
            search_path: ".".into(),
            query: "DEEP_\\w+".into(),
            is_regex: Some(true),
            case_sensitive: None,
            includes: None,
            max_results: None,
            context_lines: None,
        };
        let resp = execute_grep(args, &ws).await;
        assert!(resp.ok);
        let data: GrepResult = serde_json::from_value(resp.data.unwrap()).unwrap();
        assert!(data.total >= 2);
    }

    #[tokio::test]
    async fn test_grep_case_sensitive() {
        let dir = TempDir::new().unwrap();
        let ws = setup_tree(&dir);

        let insensitive = execute_grep(GrepArgs {
            search_path: ".".into(),
            query: "HELLO".into(),
            is_regex: None,
            case_sensitive: Some(false),
            includes: None,
            max_results: None,
            context_lines: None,
        }, &ws).await;

        let sensitive = execute_grep(GrepArgs {
            search_path: ".".into(),
            query: "HELLO".into(),
            is_regex: None,
            case_sensitive: Some(true),
            includes: None,
            max_results: None,
            context_lines: None,
        }, &ws).await;

        let ins_data: GrepResult = serde_json::from_value(insensitive.data.unwrap()).unwrap();
        let sen_data: GrepResult = serde_json::from_value(sensitive.data.unwrap()).unwrap();
        assert!(ins_data.total > sen_data.total);
    }

    #[tokio::test]
    async fn test_grep_includes_filter() {
        let dir = TempDir::new().unwrap();
        let ws = setup_tree(&dir);
        let args = GrepArgs {
            search_path: ".".into(),
            query: "export".into(),
            is_regex: None,
            case_sensitive: None,
            includes: Some(vec!["*.md".into()]),
            max_results: None,
            context_lines: None,
        };
        let resp = execute_grep(args, &ws).await;
        assert!(resp.ok);
        let data: GrepResult = serde_json::from_value(resp.data.unwrap()).unwrap();
        // "export" appears only in .ts files, not .md
        assert_eq!(data.total, 0);
    }

    #[tokio::test]
    async fn test_grep_max_results() {
        let dir = TempDir::new().unwrap();
        let ws = setup_tree(&dir);
        let args = GrepArgs {
            search_path: ".".into(),
            query: "export".into(),
            is_regex: None,
            case_sensitive: None,
            includes: None,
            max_results: Some(1),
            context_lines: None,
        };
        let resp = execute_grep(args, &ws).await;
        assert!(resp.ok);
        let data: GrepResult = serde_json::from_value(resp.data.unwrap()).unwrap();
        assert_eq!(data.total, 1);
        assert!(data.truncated);
    }

    #[tokio::test]
    async fn test_grep_invalid_regex() {
        let dir = TempDir::new().unwrap();
        let ws = dir.path().display().to_string();
        std_fs::write(dir.path().join("test.txt"), "hello").unwrap();
        let args = GrepArgs {
            search_path: ".".into(),
            query: "[invalid".into(),
            is_regex: Some(true),
            case_sensitive: None,
            includes: None,
            max_results: None,
            context_lines: None,
        };
        let resp = execute_grep(args, &ws).await;
        assert!(!resp.ok);
        assert!(resp.error.unwrap().to_lowercase().contains("regex"));
    }
}
