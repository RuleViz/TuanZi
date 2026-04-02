//! stdio.rs — MCP stdio transport client.
//!
//! Spawns a child process, communicates via JSON-RPC over Content-Length framed
//! stdin/stdout. Mirrors `StdioMcpClient` from `stdio-mcp-client.ts`.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

use crate::framing;

type PendingMap = HashMap<u64, oneshot::Sender<Result<serde_json::Value, String>>>;

/// A running MCP stdio client.
pub struct StdioClient {
    inner: Arc<Mutex<StdioInner>>,
    next_id: Arc<AtomicU64>,
    _reader_task: JoinHandle<()>,
    request_timeout_ms: u64,
}

struct StdioInner {
    stdin: Option<ChildStdin>,
    child: Option<Child>,
    pending: PendingMap,
}

impl StdioClient {
    /// Start a new MCP stdio client.
    pub async fn start(
        command: &str,
        args: &[String],
        env: &HashMap<String, String>,
        startup_timeout_ms: u64,
        request_timeout_ms: u64,
    ) -> Result<Self, String> {
        if command.trim().is_empty() {
            return Err("MCP command is empty.".to_string());
        }

        let use_shell = cfg!(windows);
        let mut cmd = if use_shell {
            let mut c = tokio::process::Command::new("cmd");
            c.arg("/C").arg(command);
            for arg in args {
                c.arg(arg);
            }
            c
        } else {
            let mut c = tokio::process::Command::new(command);
            c.args(args);
            c
        };

        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.env("CI", "1");
        cmd.env("NPM_CONFIG_YES", "true");
        for (k, v) in env {
            cmd.env(k, v);
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn MCP process: {e}"))?;
        let stdin = child.stdin.take().ok_or("Failed to capture stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
        // stderr is intentionally not captured (stays inherited for diagnostics)

        let inner = Arc::new(Mutex::new(StdioInner {
            stdin: Some(stdin),
            child: Some(child),
            pending: HashMap::new(),
        }));

        let next_id = Arc::new(AtomicU64::new(1));

        // Spawn background reader task
        let reader_inner = inner.clone();
        let reader_task = tokio::spawn(async move {
            reader_loop(stdout, reader_inner).await;
        });

        let client = Self {
            inner,
            next_id,
            _reader_task: reader_task,
            request_timeout_ms,
        };

        // Send initialize
        client
            .request(
                "initialize",
                serde_json::json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": { "name": "tuanzi", "version": "0.2.0" }
                }),
                startup_timeout_ms,
            )
            .await?;

        // Send initialized notification
        client
            .notify("notifications/initialized", serde_json::json!({}))
            .await?;

        Ok(client)
    }

    /// Call a tool on the MCP server.
    pub async fn call_tool(
        &self,
        tool_name: &str,
        arguments: serde_json::Value,
        timeout_ms: Option<u64>,
    ) -> Result<serde_json::Value, String> {
        self.request(
            "tools/call",
            serde_json::json!({
                "name": tool_name,
                "arguments": arguments
            }),
            timeout_ms.unwrap_or(self.request_timeout_ms),
        )
        .await
    }

    /// List tools from the MCP server (handles pagination).
    pub async fn list_tools(
        &self,
        timeout_ms: Option<u64>,
    ) -> Result<Vec<serde_json::Value>, String> {
        let tm = timeout_ms.unwrap_or(self.request_timeout_ms);
        let mut output = Vec::new();
        let mut cursor: Option<String> = None;

        loop {
            let params = match &cursor {
                Some(c) => serde_json::json!({ "cursor": c }),
                None => serde_json::json!({}),
            };

            let result = self.request("tools/list", params, tm).await?;
            if let Some(tools) = result.get("tools").and_then(|v| v.as_array()) {
                output.extend(tools.iter().cloned());
            }

            let next = result
                .get("nextCursor")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            match next {
                Some(c) => cursor = Some(c),
                None => break,
            }
        }

        Ok(output)
    }

    /// Stop the MCP client (kill process, cleanup).
    pub async fn stop(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().await;

        // Close stdin
        if let Some(mut stdin) = inner.stdin.take() {
            let _ = stdin.shutdown().await;
        }

        // Kill process
        if let Some(mut child) = inner.child.take() {
            #[cfg(windows)]
            {
                if let Some(pid) = child.id() {
                    let _ = tokio::process::Command::new("taskkill")
                        .args(["/pid", &pid.to_string(), "/T", "/F"])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .await;
                }
            }
            let _ = child.start_kill();
            let _ = child.wait().await;
        }

        // Reject all pending
        for (_, tx) in inner.pending.drain() {
            let _ = tx.send(Err("MCP client stopped.".to_string()));
        }

        Ok(())
    }

    async fn request(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout_ms: u64,
    ) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();

        {
            let mut inner = self.inner.lock().await;
            inner.pending.insert(id, tx);

            let payload = serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params
            });

            let body = serde_json::to_string(&payload)
                .map_err(|e| format!("Serialization error: {e}"))?;
            let frame = framing::frame_message(&body);

            if let Some(stdin) = &mut inner.stdin {
                stdin
                    .write_all(&frame)
                    .await
                    .map_err(|e| format!("Write error: {e}"))?;
                stdin.flush().await.map_err(|e| format!("Flush error: {e}"))?;
            } else {
                return Err("MCP process stdin is not available.".to_string());
            }
        }

        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("MCP request cancelled.".to_string()),
            Err(_) => {
                let mut inner = self.inner.lock().await;
                inner.pending.remove(&id);
                Err(format!(
                    "MCP request timed out: {method} (waited {timeout_ms}ms)"
                ))
            }
        }
    }

    async fn notify(&self, method: &str, params: serde_json::Value) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        let body =
            serde_json::to_string(&payload).map_err(|e| format!("Serialization error: {e}"))?;
        let frame = framing::frame_message(&body);

        if let Some(stdin) = &mut inner.stdin {
            stdin
                .write_all(&frame)
                .await
                .map_err(|e| format!("Write error: {e}"))?;
            stdin.flush().await.map_err(|e| format!("Flush error: {e}"))?;
        }
        Ok(())
    }
}

/// Background task: continuously read stdout frames and dispatch to pending requests.
async fn reader_loop(
    mut stdout: tokio::process::ChildStdout,
    inner: Arc<Mutex<StdioInner>>,
) {
    let mut buffer = Vec::new();
    let mut read_buf = [0u8; 8192];

    loop {
        match stdout.read(&mut read_buf).await {
            Ok(0) => break, // EOF
            Ok(n) => {
                buffer.extend_from_slice(&read_buf[..n]);

                // Extract as many frames as possible
                while let Some((payload, consumed)) = framing::try_extract_frame(&buffer) {
                    buffer.drain(..consumed);

                    if payload.is_empty() {
                        continue;
                    }

                    let json: serde_json::Value = match serde_json::from_str(&payload) {
                        Ok(v) => v,
                        Err(_) => continue, // Skip non-JSON lines
                    };

                    if let Some(id) = json.get("id").and_then(|v| v.as_u64()) {
                        let mut inner = inner.lock().await;
                        if let Some(tx) = inner.pending.remove(&id) {
                            if let Some(error) = json.get("error") {
                                let code = error
                                    .get("code")
                                    .and_then(|v| v.as_i64())
                                    .unwrap_or(0);
                                let msg = error
                                    .get("message")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Unknown error");
                                let _ = tx.send(Err(format!("MCP error {code}: {msg}")));
                            } else {
                                let result = json
                                    .get("result")
                                    .cloned()
                                    .unwrap_or(serde_json::Value::Null);
                                let _ = tx.send(Ok(result));
                            }
                        }
                    }
                    // Ignore messages without an id (notifications, etc.)
                }
            }
            Err(_) => break,
        }
    }

    // Process exited — reject all pending
    let mut inner = inner.lock().await;
    for (_, tx) in inner.pending.drain() {
        let _ = tx.send(Err("MCP process exited.".to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_start_invalid_command() {
        let result = StdioClient::start(
            "",
            &[],
            &HashMap::new(),
            5000,
            5000,
        )
        .await;
        match result {
            Ok(_) => panic!("Expected error for empty command"),
            Err(e) => assert!(e.contains("empty"), "Error should mention empty: {e}"),
        }
    }

    #[tokio::test]
    async fn test_start_nonexistent_command() {
        let result = StdioClient::start(
            "this_mcp_server_does_not_exist_99999",
            &[],
            &HashMap::new(),
            3000,
            3000,
        )
        .await;
        // Should fail to spawn or fail on initialize timeout
        assert!(result.is_err());
    }
}
