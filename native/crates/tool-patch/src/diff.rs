//! diff.rs — Unified diff parser and hunk applier.
//!
//! This is a faithful port of the TypeScript `parseUnifiedDiff`, `findHunkPosition`,
//! `applyHunk`, and related functions from `edit.ts`.

/// A single operation within a hunk.
#[derive(Debug, Clone, PartialEq)]
pub enum DiffOpType {
    Context,
    Remove,
    Add,
}

#[derive(Debug, Clone)]
pub struct DiffOperation {
    pub op_type: DiffOpType,
    pub content: String,
}

/// A parsed hunk from a unified diff.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct DiffHunk {
    pub original_start: usize,
    pub original_count: usize,
    pub new_start: usize,
    pub new_count: usize,
    pub operations: Vec<DiffOperation>,
}

/// Parse a unified diff text into a list of hunks.
///
/// Mirrors `parseUnifiedDiff()` from edit.ts.
pub fn parse_unified_diff(diff_text: &str) -> Vec<DiffHunk> {
    let mut hunks = Vec::new();
    let lines: Vec<&str> = diff_text.split('\n').collect();
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index];

        // Skip --- and +++ header lines
        if line.starts_with("---") || line.starts_with("+++") {
            index += 1;
            continue;
        }

        // Try to parse @@ hunk header
        if let Some(hunk_header) = parse_hunk_header(line) {
            let mut hunk = DiffHunk {
                original_start: hunk_header.0,
                original_count: hunk_header.1,
                new_start: hunk_header.2,
                new_count: hunk_header.3,
                operations: Vec::new(),
            };
            index += 1;

            // Parse hunk body
            while index < lines.len() && !lines[index].starts_with("@@") {
                let body_line = lines[index];
                if let Some(stripped) = body_line.strip_prefix(' ') {
                    hunk.operations.push(DiffOperation {
                        op_type: DiffOpType::Context,
                        content: stripped.to_string(),
                    });
                } else if let Some(stripped) = body_line.strip_prefix('-') {
                    hunk.operations.push(DiffOperation {
                        op_type: DiffOpType::Remove,
                        content: stripped.to_string(),
                    });
                } else if let Some(stripped) = body_line.strip_prefix('+') {
                    hunk.operations.push(DiffOperation {
                        op_type: DiffOpType::Add,
                        content: stripped.to_string(),
                    });
                } else if body_line == "\\ No newline at end of file" {
                    // Skip marker line
                } else {
                    break;
                }
                index += 1;
            }

            hunks.push(hunk);
        } else {
            index += 1;
        }
    }

    hunks
}

/// Parse `@@ -origStart,origCount +newStart,newCount @@` header.
/// Returns (original_start, original_count, new_start, new_count).
fn parse_hunk_header(line: &str) -> Option<(usize, usize, usize, usize)> {
    // Match: @@ -N[,N] +N[,N] @@
    let line = line.trim_start();
    if !line.starts_with("@@") {
        return None;
    }

    // Find the content between @@ markers
    let after_first = &line[2..];
    let end_marker = after_first.find("@@")?;
    let inner = after_first[..end_marker].trim();

    // Parse -N,N +N,N
    let parts: Vec<&str> = inner.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }

    let minus_part = parts[0].strip_prefix('-')?;
    let plus_part = parts[1].strip_prefix('+')?;

    let (orig_start, orig_count) = parse_range(minus_part)?;
    let (new_start, new_count) = parse_range(plus_part)?;

    Some((orig_start, orig_count, new_start, new_count))
}

/// Parse "N" or "N,N" into (start, count).
fn parse_range(s: &str) -> Option<(usize, usize)> {
    if let Some((start_s, count_s)) = s.split_once(',') {
        let start = start_s.parse::<usize>().ok()?;
        let count = count_s.parse::<usize>().ok()?;
        Some((start, count))
    } else {
        let start = s.parse::<usize>().ok()?;
        Some((start, 1))
    }
}

/// Result of attempting to find where a hunk matches in the file.
pub struct HunkMatch {
    pub found: bool,
    pub offset: i64,
}

/// Find the position in `file_lines` where `hunk` matches, with fuzzy tolerance.
///
/// Mirrors `findHunkPosition()` from edit.ts.
pub fn find_hunk_position(file_lines: &[String], hunk: &DiffHunk, fuzz: u32) -> HunkMatch {
    let expected_lines: Vec<&str> = hunk
        .operations
        .iter()
        .filter(|op| op.op_type == DiffOpType::Context || op.op_type == DiffOpType::Remove)
        .map(|op| op.content.as_str())
        .collect();

    let exact_start = hunk.original_start as i64 - 1;

    // Try exact position
    if matches_at(file_lines, &expected_lines, exact_start) {
        return HunkMatch { found: true, offset: 0 };
    }

    // Try fuzz range
    for delta in 1..=fuzz as i64 {
        if matches_at(file_lines, &expected_lines, exact_start - delta) {
            return HunkMatch { found: true, offset: -delta };
        }
        if matches_at(file_lines, &expected_lines, exact_start + delta) {
            return HunkMatch { found: true, offset: delta };
        }
    }

    HunkMatch { found: false, offset: 0 }
}

/// Check if `expected_lines` match `file_lines` starting at `start_index`.
fn matches_at(file_lines: &[String], expected_lines: &[&str], start_index: i64) -> bool {
    if expected_lines.is_empty() {
        return start_index >= 0 && start_index as usize <= file_lines.len();
    }
    if start_index < 0 {
        return false;
    }
    let start = start_index as usize;
    if start + expected_lines.len() > file_lines.len() {
        return false;
    }
    for (i, expected) in expected_lines.iter().enumerate() {
        if file_lines[start + i] != *expected {
            return false;
        }
    }
    true
}

/// Apply a single hunk to `file_lines` at the given offset.
///
/// Mirrors `applyHunk()` from edit.ts.
pub fn apply_hunk(file_lines: &mut Vec<String>, hunk: &DiffHunk, offset: i64) {
    let start = (hunk.original_start as i64 - 1 + offset) as usize;
    let expected_length = hunk
        .operations
        .iter()
        .filter(|op| op.op_type != DiffOpType::Add)
        .count();
    let replacement: Vec<String> = hunk
        .operations
        .iter()
        .filter(|op| op.op_type != DiffOpType::Remove)
        .map(|op| op.content.clone())
        .collect();

    // Splice: remove `expected_length` lines at `start`, insert `replacement`
    let end = (start + expected_length).min(file_lines.len());
    file_lines.splice(start..end, replacement);
}

/// Count the total number of added and removed lines across all hunks.
pub fn count_changed_lines(hunks: &[DiffHunk]) -> usize {
    let mut count = 0;
    for hunk in hunks {
        for op in &hunk.operations {
            if op.op_type == DiffOpType::Add || op.op_type == DiffOpType::Remove {
                count += 1;
            }
        }
    }
    count
}

/// Split content preserving empty last line (matches TS behavior).
pub fn split_preserve_empty_last_line(content: &str) -> Vec<String> {
    if content.is_empty() {
        return vec![String::new()];
    }
    content.split('\n').map(|s| s.to_string()).collect()
}

/// Join lines preserving empty last line (matches TS behavior).
pub fn join_preserve_empty_last_line(lines: &[String]) -> String {
    if lines.len() == 1 && lines[0].is_empty() {
        return String::new();
    }
    lines.join("\n")
}

/// Check if text looks like a unified diff (but failed to parse properly).
pub fn looks_like_unified_diff(diff_text: &str) -> bool {
    // Has @@ hunk header
    let has_header = diff_text.lines().any(|line| {
        let trimmed = line.trim_start();
        trimmed.starts_with("@@") && trimmed.contains("+") && trimmed.contains("-")
    });
    // Has prefixed lines
    let has_prefixed = diff_text.lines().any(|line| {
        line.starts_with(' ') || line.starts_with('+') || line.starts_with('-')
    });
    has_header || has_prefixed
}

/// Describe a mismatch between a hunk and the file content for error reporting.
pub fn describe_hunk_mismatch(
    file_lines: &[String],
    hunk: &DiffHunk,
) -> Option<HunkMismatch> {
    let expected_lines: Vec<&str> = hunk
        .operations
        .iter()
        .filter(|op| op.op_type == DiffOpType::Context || op.op_type == DiffOpType::Remove)
        .map(|op| op.content.as_str())
        .collect();

    if expected_lines.is_empty() {
        return None;
    }

    let start_index = hunk.original_start.saturating_sub(1);
    for (i, expected) in expected_lines.iter().enumerate() {
        let file_index = start_index + i;
        let actual = if file_index < file_lines.len() {
            file_lines[file_index].as_str()
        } else {
            "<end of file>"
        };
        if actual != *expected {
            return Some(HunkMismatch {
                line: file_index + 1,
                expected: expected.to_string(),
                actual: actual.to_string(),
            });
        }
    }

    None
}

pub struct HunkMismatch {
    pub line: usize,
    pub expected: String,
    pub actual: String,
}

/// Quote a string for error messages, truncating at 120 chars.
pub fn quote_for_error(line: &str) -> String {
    let compact = if line.len() > 120 {
        format!("{}...", &line[..117])
    } else {
        line.to_string()
    };
    format!("{:?}", compact)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_single_hunk() {
        let diff = "@@ -1,3 +1,4 @@\n context line\n-old line\n+new line\n+added line\n context end";
        let hunks = parse_unified_diff(diff);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].original_start, 1);
        assert_eq!(hunks[0].original_count, 3);
        assert_eq!(hunks[0].new_start, 1);
        assert_eq!(hunks[0].new_count, 4);
        assert_eq!(hunks[0].operations.len(), 5);
    }

    #[test]
    fn test_parse_multiple_hunks() {
        let diff = "\
@@ -1,2 +1,2 @@
 line one
-line two
+line TWO
@@ -10,2 +10,3 @@
 line ten
-line eleven
+line ELEVEN
+new insertion";
        let hunks = parse_unified_diff(diff);
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0].original_start, 1);
        assert_eq!(hunks[1].original_start, 10);
    }

    #[test]
    fn test_parse_with_header_lines() {
        let diff = "\
--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 unchanged
-old
+new";
        let hunks = parse_unified_diff(diff);
        assert_eq!(hunks.len(), 1);
    }

    #[test]
    fn test_parse_invalid_diff() {
        let diff = "this is not a diff at all";
        let hunks = parse_unified_diff(diff);
        assert_eq!(hunks.len(), 0);
    }

    #[test]
    fn test_find_hunk_exact_match() {
        let file_lines: Vec<String> = vec![
            "line 1".into(),
            "line 2".into(),
            "line 3".into(),
        ];
        let hunk = DiffHunk {
            original_start: 2,
            original_count: 1,
            new_start: 2,
            new_count: 1,
            operations: vec![
                DiffOperation {
                    op_type: DiffOpType::Remove,
                    content: "line 2".into(),
                },
                DiffOperation {
                    op_type: DiffOpType::Add,
                    content: "line TWO".into(),
                },
            ],
        };
        let m = find_hunk_position(&file_lines, &hunk, 0);
        assert!(m.found);
        assert_eq!(m.offset, 0);
    }

    #[test]
    fn test_find_hunk_with_fuzz() {
        let file_lines: Vec<String> = vec![
            "header".into(),
            "line 1".into(),
            "target line".into(),
            "line 3".into(),
        ];
        // Hunk claims originalStart=2, but actual match is at line 3 (index 2)
        let hunk = DiffHunk {
            original_start: 2,
            original_count: 1,
            new_start: 2,
            new_count: 1,
            operations: vec![
                DiffOperation {
                    op_type: DiffOpType::Remove,
                    content: "target line".into(),
                },
                DiffOperation {
                    op_type: DiffOpType::Add,
                    content: "replaced".into(),
                },
            ],
        };
        // fuzz=0 should fail (expects at index 1, but "line 1" != "target line")
        let m = find_hunk_position(&file_lines, &hunk, 0);
        assert!(!m.found);

        // fuzz=2 should succeed with offset +1
        let m = find_hunk_position(&file_lines, &hunk, 2);
        assert!(m.found);
        assert_eq!(m.offset, 1);
    }

    #[test]
    fn test_apply_hunk_simple() {
        let mut lines: Vec<String> = vec![
            "line 1".into(),
            "old line".into(),
            "line 3".into(),
        ];
        let hunk = DiffHunk {
            original_start: 2,
            original_count: 1,
            new_start: 2,
            new_count: 1,
            operations: vec![
                DiffOperation {
                    op_type: DiffOpType::Remove,
                    content: "old line".into(),
                },
                DiffOperation {
                    op_type: DiffOpType::Add,
                    content: "new line".into(),
                },
            ],
        };
        apply_hunk(&mut lines, &hunk, 0);
        assert_eq!(lines, vec!["line 1", "new line", "line 3"]);
    }

    #[test]
    fn test_noop_detection() {
        let content = "line 1\nline 2\nline 3";
        let lines = split_preserve_empty_last_line(content);
        let rejoined = join_preserve_empty_last_line(&lines);
        assert_eq!(content, rejoined);
    }

    #[test]
    fn test_describe_mismatch() {
        let file_lines: Vec<String> = vec![
            "alpha".into(),
            "DIFFERENT".into(),
            "gamma".into(),
        ];
        let hunk = DiffHunk {
            original_start: 1,
            original_count: 2,
            new_start: 1,
            new_count: 2,
            operations: vec![
                DiffOperation {
                    op_type: DiffOpType::Context,
                    content: "alpha".into(),
                },
                DiffOperation {
                    op_type: DiffOpType::Remove,
                    content: "beta".into(),
                },
                DiffOperation {
                    op_type: DiffOpType::Add,
                    content: "BETA".into(),
                },
            ],
        };
        let mismatch = describe_hunk_mismatch(&file_lines, &hunk);
        assert!(mismatch.is_some());
        let m = mismatch.unwrap();
        assert_eq!(m.line, 2);
        assert_eq!(m.expected, "beta");
        assert_eq!(m.actual, "DIFFERENT");
    }
}
