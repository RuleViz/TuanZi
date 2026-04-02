//! preview.rs — Diff preview generation.
//!
//! Mirrors `createLineDiffPreview()` from TypeScript's diff-preview.ts.
//! This is a simple line-by-line comparison for visual display.

/// Generate a line diff preview between previous and next content.
///
/// Returns a string with `@@ line N @@` markers showing changed lines.
/// Truncates after `max_changed_lines` changes.
pub fn create_line_diff_preview(
    previous_content: &str,
    next_content: &str,
    max_changed_lines: usize,
) -> String {
    let previous_lines: Vec<&str> = previous_content.split('\n').collect();
    let next_lines: Vec<&str> = next_content.split('\n').collect();
    let max_length = previous_lines.len().max(next_lines.len());

    let mut output = Vec::new();
    let mut changed_count = 0;

    for index in 0..max_length {
        let before = previous_lines.get(index).copied();
        let after = next_lines.get(index).copied();

        if before == after {
            continue;
        }

        let line_number = index + 1;
        output.push(format!("@@ line {line_number} @@"));
        if let Some(b) = before {
            output.push(format!("- {b}"));
        }
        if let Some(a) = after {
            output.push(format!("+ {a}"));
        }
        changed_count += 1;

        if changed_count >= max_changed_lines {
            output.push("... diff preview truncated ...".to_string());
            break;
        }
    }

    if output.is_empty() {
        return "No content change detected.".to_string();
    }
    output.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_change() {
        let result = create_line_diff_preview("hello\nworld", "hello\nworld", 80);
        assert_eq!(result, "No content change detected.");
    }

    #[test]
    fn test_single_line_change() {
        let result = create_line_diff_preview("hello\nworld", "hello\nRust", 80);
        assert!(result.contains("@@ line 2 @@"));
        assert!(result.contains("- world"));
        assert!(result.contains("+ Rust"));
    }

    #[test]
    fn test_truncation() {
        let prev = "a\nb\nc\nd\ne";
        let next = "A\nB\nC\nD\nE";
        let result = create_line_diff_preview(prev, next, 2);
        assert!(result.contains("... diff preview truncated ..."));
    }
}
