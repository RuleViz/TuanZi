//! bash.rs — Shell command execution kernel.
//!
//! Mirrors the `executeShellCommand` path from `bash.ts`.
//! Does NOT handle policy checks, approval gates, or terminal bridge — those stay in TS.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use regex::Regex;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tool_protocol::{BashExecArgs, BashExecResult, ToolResponse};

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MIDDLE_TRUNCATION_MARKER: &str = "\n[... middle output omitted ...]\n";

static DANGEROUS_PATTERNS: &[&str] = &[
    r"(?i)\brm\s+-rf\b",
    r"(?i)\bdel\s+/f\b",
    r"(?i)\bformat\b",
    r"(?i)\bmkfs\b",
    r"(?i)\bshutdown\b",
    r"(?i)\breboot\b",
    r"(?i)\bgit\s+reset\s+--hard\b",
];

static ANSI_RE: OnceLock<Regex> = OnceLock::new();

fn ansi_regex() -> &'static Regex {
    ANSI_RE.get_or_init(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap())
}

/// Execute a shell command (the kernel of the bash tool).
pub async fn execute(args: BashExecArgs, workspace_root: &str) -> ToolResponse {
    if args.command.trim().is_empty() {
        return ToolResponse::failure("command is required and must be a non-empty string.");
    }

    let cwd = args.cwd.unwrap_or_else(|| workspace_root.to_string());
    let timeout_ms = clamp(args.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS), 1000, 900_000);
    let max_output = args.max_output_chars.map(|v| clamp(v, 500, 20_000) as usize);
    let env_overrides = args.env.unwrap_or_default();
    let is_dangerous = check_dangerous(&args.command);

    // Validate cwd exists
    match tokio::fs::metadata(&cwd).await {
        Ok(m) if m.is_dir() => {}
        _ => return ToolResponse::failure(format!("cwd is invalid: {cwd}")),
    }

    let started_at = Instant::now();

    // Build the shell command
    let mut cmd = build_shell_command(&args.command);
    cmd.current_dir(&cwd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.env("CI", "1");
    cmd.env("NPM_CONFIG_YES", "true");
    for (k, v) in &env_overrides {
        cmd.env(k, v);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return ToolResponse::failure(format!("Failed to spawn command: {e}")),
    };

    let mut stdout_handle = child.stdout.take().unwrap();
    let mut stderr_handle = child.stderr.take().unwrap();

    // Spawn I/O readers so they run concurrently
    let stdout_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stdout_handle.read_to_end(&mut buf).await;
        buf
    });
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr_handle.read_to_end(&mut buf).await;
        buf
    });

    // Wait for process with timeout
    let mut timed_out = false;
    let mut force_killed = false;
    let exit_code: Option<i32>;
    let signal: Option<String>;

    tokio::select! {
        status = child.wait() => {
            match status {
                Ok(s) => {
                    exit_code = s.code();
                    signal = None;
                }
                Err(e) => {
                    exit_code = Some(1);
                    signal = Some(format!("Process error: {e}"));
                }
            }
        }
        _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
            timed_out = true;
            force_killed = true;
            let _ = child.start_kill();
            // Reap the child
            let _ = child.wait().await;
            exit_code = None;
            signal = Some("SIGKILL".to_string());
        }
    }

    // Collect output
    let stdout_buf = stdout_task.await.unwrap_or_default();
    let stderr_buf = stderr_task.await.unwrap_or_default();
    let duration_ms = started_at.elapsed().as_millis() as u64;

    let stdout = sanitize_output(&String::from_utf8_lossy(&stdout_buf), max_output);
    let stderr = sanitize_output(&String::from_utf8_lossy(&stderr_buf), max_output);

    let result = BashExecResult {
        command: args.command,
        cwd,
        exit_code,
        signal,
        timed_out,
        interrupted: false,
        force_killed,
        duration_ms,
        stdout: stdout.clone(),
        stderr: stderr.clone(),
        is_dangerous,
    };

    let value = match serde_json::to_value(&result) {
        Ok(v) => v,
        Err(e) => return ToolResponse::failure(format!("Serialization error: {e}")),
    };

    let failed = timed_out || exit_code.map_or(false, |c| c != 0);
    if failed {
        let exit_display = if timed_out {
            "timeout".to_string()
        } else {
            exit_code.map_or("unknown".to_string(), |c| c.to_string())
        };
        let stdout_section = if stdout.is_empty() {
            String::new()
        } else {
            format!("\nstdout:\n{stdout}")
        };
        let error_msg = format!(
            "Command failed (Exit Code {exit_display}). stderr:\n{}{}",
            if stderr.is_empty() { "[empty]" } else { &stderr },
            stdout_section
        );
        ToolResponse {
            ok: false,
            data: Some(value),
            error: Some(error_msg),
        }
    } else {
        ToolResponse::success(value)
    }
}

fn build_shell_command(command: &str) -> Command {
    if cfg!(windows) {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(command);
        cmd
    } else {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(command);
        cmd
    }
}

fn check_dangerous(command: &str) -> bool {
    for pattern in DANGEROUS_PATTERNS {
        if let Ok(re) = Regex::new(pattern) {
            if re.is_match(command) {
                return true;
            }
        }
    }
    false
}

fn strip_ansi(text: &str) -> String {
    ansi_regex().replace_all(text, "").into_owned()
}

fn sanitize_output(text: &str, max_length: Option<usize>) -> String {
    let stripped = strip_ansi(text);
    match max_length {
        Some(max) => truncate_middle(&stripped, max),
        None => stripped,
    }
}

fn truncate_middle(text: &str, max_length: usize) -> String {
    if text.len() <= max_length {
        return text.to_string();
    }
    let marker_len = MIDDLE_TRUNCATION_MARKER.len();
    let available = max_length.saturating_sub(marker_len);
    if available == 0 {
        return text[..max_length].to_string();
    }
    let head = (available as f64 * 0.6).ceil() as usize;
    let tail = (available as f64 * 0.4).floor() as usize;
    format!(
        "{}{}{}",
        &text[..head],
        MIDDLE_TRUNCATION_MARKER,
        &text[text.len().saturating_sub(tail)..]
    )
}

fn clamp(value: u64, min: u64, max: u64) -> u64 {
    value.max(min).min(max)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_echo_command() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        let args = BashExecArgs {
            command: if cfg!(windows) {
                "echo hello".to_string()
            } else {
                "echo hello".to_string()
            },
            cwd: None,
            timeout_ms: Some(10_000),
            max_output_chars: None,
            env: None,
        };
        let resp = execute(args, workspace).await;
        assert!(resp.ok, "Error: {:?}", resp.error);
        let data: BashExecResult = serde_json::from_value(resp.data.unwrap()).unwrap();
        assert!(data.stdout.trim().contains("hello"));
        assert_eq!(data.exit_code, Some(0));
        assert!(!data.timed_out);
    }

    #[tokio::test]
    async fn test_nonexistent_command() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        let args = BashExecArgs {
            command: "this_command_does_not_exist_12345".to_string(),
            cwd: None,
            timeout_ms: Some(10_000),
            max_output_chars: None,
            env: None,
        };
        let resp = execute(args, workspace).await;
        assert!(!resp.ok);
    }

    #[tokio::test]
    async fn test_empty_command() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        let args = BashExecArgs {
            command: "  ".to_string(),
            cwd: None,
            timeout_ms: None,
            max_output_chars: None,
            env: None,
        };
        let resp = execute(args, workspace).await;
        assert!(!resp.ok);
        assert!(resp.error.unwrap().contains("command is required"));
    }

    #[tokio::test]
    async fn test_invalid_cwd() {
        let args = BashExecArgs {
            command: "echo hi".to_string(),
            cwd: Some("/nonexistent_dir_12345".to_string()),
            timeout_ms: Some(5_000),
            max_output_chars: None,
            env: None,
        };
        let resp = execute(args, "/tmp").await;
        assert!(!resp.ok);
        assert!(resp.error.unwrap().contains("cwd is invalid"));
    }

    #[tokio::test]
    async fn test_env_override() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        let mut env = HashMap::new();
        env.insert("TUANZI_TEST_VAR".to_string(), "rust_value".to_string());

        let args = BashExecArgs {
            command: if cfg!(windows) {
                "echo %TUANZI_TEST_VAR%".to_string()
            } else {
                "echo $TUANZI_TEST_VAR".to_string()
            },
            cwd: None,
            timeout_ms: Some(10_000),
            max_output_chars: None,
            env: Some(env),
        };
        let resp = execute(args, workspace).await;
        assert!(resp.ok, "Error: {:?}", resp.error);
        let data: BashExecResult = serde_json::from_value(resp.data.unwrap()).unwrap();
        assert!(data.stdout.contains("rust_value"));
    }

    #[tokio::test]
    async fn test_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        let args = BashExecArgs {
            command: if cfg!(windows) {
                "ping -n 30 127.0.0.1".to_string()
            } else {
                "sleep 30".to_string()
            },
            cwd: None,
            timeout_ms: Some(1_000), // 1 second timeout
            max_output_chars: None,
            env: None,
        };
        let resp = execute(args, workspace).await;
        assert!(!resp.ok);
        let data: BashExecResult = serde_json::from_value(resp.data.unwrap()).unwrap();
        assert!(data.timed_out);
        assert!(data.force_killed);
    }

    #[test]
    fn test_dangerous_detection() {
        assert!(check_dangerous("rm -rf /"));
        assert!(check_dangerous("git reset --hard HEAD~5"));
        assert!(!check_dangerous("echo hello"));
        assert!(!check_dangerous("ls -la"));
    }

    #[test]
    fn test_strip_ansi() {
        let input = "\x1b[31mred\x1b[0m normal";
        assert_eq!(strip_ansi(input), "red normal");
    }

    #[test]
    fn test_truncate_middle() {
        let text = "a".repeat(200);
        let result = truncate_middle(&text, 100);
        assert!(result.len() <= 100 + MIDDLE_TRUNCATION_MARKER.len());
        assert!(result.contains(MIDDLE_TRUNCATION_MARKER));
    }

    #[test]
    fn test_truncate_short_text() {
        assert_eq!(truncate_middle("short", 100), "short");
    }
}
