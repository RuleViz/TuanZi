//! Path utilities mirroring src/core/path-utils.ts behaviour.

use std::path::{Path, PathBuf};
use tool_protocol::ToolError;

/// Resolve a path (relative or absolute) against the workspace root.
/// Mirrors `resolveSafePath()` in TypeScript.
pub fn resolve_safe_path(input_path: &str, workspace_root: &str) -> Result<PathBuf, ToolError> {
    if input_path.is_empty() {
        return Err(ToolError::InvalidArgs("path must be a non-empty string.".into()));
    }
    if workspace_root.is_empty() {
        return Err(ToolError::InvalidArgs("workspaceRoot must be a non-empty string.".into()));
    }

    let p = Path::new(input_path);
    let resolved = if p.is_absolute() {
        dunce_lite_resolve(p)
    } else {
        dunce_lite_resolve(&Path::new(workspace_root).join(p))
    };

    Ok(resolved.into())
}

/// Assert that `absolute_path` is inside `workspace_root`.
/// Mirrors `assertInsideWorkspace()` in TypeScript (case-insensitive on Windows).
pub fn assert_inside_workspace(absolute_path: &Path, workspace_root: &str) -> Result<(), ToolError> {
    let root = strip_trailing_sep(&dunce_lite_resolve(Path::new(workspace_root)));
    let target = strip_trailing_sep(&dunce_lite_resolve(absolute_path));

    let (root_cmp, target_cmp) = if cfg!(windows) {
        (root.to_lowercase(), target.to_lowercase())
    } else {
        (root.clone(), target.clone())
    };

    let sep = std::path::MAIN_SEPARATOR.to_string();
    let starts = target_cmp == root_cmp || target_cmp.starts_with(&format!("{root_cmp}{sep}"));

    if !starts {
        return Err(ToolError::PathOutsideWorkspace {
            path: absolute_path.display().to_string(),
        });
    }

    Ok(())
}

/// Convert backslashes to forward slashes (for output compatibility with TS).
pub fn to_unix_path(p: &str) -> String {
    p.replace('\\', "/")
}

/// Compute workspace-relative path in unix style.
pub fn relative_from_workspace(absolute_path: &Path, workspace_root: &Path) -> String {
    match absolute_path.strip_prefix(workspace_root) {
        Ok(rel) => to_unix_path(&rel.display().to_string()),
        Err(_) => to_unix_path(&absolute_path.display().to_string()),
    }
}

/// Minimal path canonicalization without requiring the path to actually exist.
/// On Windows, normalises `\\?\` prefix away and resolves `.`/`..`.
fn dunce_lite_resolve(p: &Path) -> String {
    // Use std::path::absolute when stable; for now do manual resolution.
    let mut components: Vec<String> = Vec::new();

    for comp in p.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                components.pop();
            }
            other => {
                components.push(other.as_os_str().to_string_lossy().to_string());
            }
        }
    }

    if cfg!(windows) {
        // Rejoin with backslash on Windows
        if components.len() == 1 {
            // Just a drive like "C:"
            format!("{}\\", components[0])
        } else {
            components.join("\\")
        }
    } else {
        if components.is_empty() {
            "/".to_string()
        } else if components[0] == "/" {
            format!("/{}", components[1..].join("/"))
        } else {
            components.join("/")
        }
    }
}

fn strip_trailing_sep(s: &str) -> String {
    s.trim_end_matches(['/', '\\']).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_relative() {
        let result = resolve_safe_path("src/main.rs", "/workspace").unwrap();
        let s = result.display().to_string();
        assert!(s.contains("src") && s.contains("main.rs"));
    }

    #[test]
    fn test_inside_workspace() {
        let ws = if cfg!(windows) { "C:\\workspace" } else { "/workspace" };
        let inside = if cfg!(windows) {
            PathBuf::from("C:\\workspace\\src\\file.rs")
        } else {
            PathBuf::from("/workspace/src/file.rs")
        };
        assert!(assert_inside_workspace(&inside, ws).is_ok());
    }

    #[test]
    fn test_outside_workspace() {
        let ws = if cfg!(windows) { "C:\\workspace" } else { "/workspace" };
        let outside = if cfg!(windows) {
            PathBuf::from("C:\\other\\file.rs")
        } else {
            PathBuf::from("/other/file.rs")
        };
        assert!(assert_inside_workspace(&outside, ws).is_err());
    }

    #[test]
    fn test_to_unix_path() {
        assert_eq!(to_unix_path("src\\nested\\file.ts"), "src/nested/file.ts");
    }
}
