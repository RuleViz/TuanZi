//! node-bridge: napi-rs bindings for native tool execution.
//!
//! Exports:
//! - `ping()` → "pong"  (module-load smoke test)
//! - `executeTool(requestJson: string)` → Promise<string>  (JSON-RPC tool dispatch)

use napi_derive::napi;
use tool_protocol::ToolRequest;

/// Smoke-test: verify the native module loads correctly.
#[napi]
pub fn ping() -> String {
    "pong".to_string()
}

/// Execute a tool by JSON request string, returning a JSON response string.
///
/// The request must be a JSON-serialized `ToolRequest`:
/// ```json
/// { "tool": "read", "args": { "path": "..." }, "workspace_root": "/abs/path" }
/// ```
#[napi]
pub async fn execute_tool(request_json: String) -> napi::Result<String> {
    let request: ToolRequest = serde_json::from_str(&request_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse tool request: {e}"))
    })?;

    // Route to the appropriate crate based on tool name
    let response = match request.tool.as_str() {
        "write" | "edit" | "delete_file" => tool_patch::dispatch(&request).await,
        "checkpoint_create" | "checkpoint_restore" | "checkpoint_list"
        | "checkpoint_diff" | "checkpoint_update_tool_calls"
        | "agent_run_save" | "agent_run_load" | "agent_run_clear"
        | "subagent_session_save" | "subagent_session_load" => {
            tool_state::dispatch(&request.tool, request.args, &request.workspace_root).await
        }
        "bash_exec" => {
            tool_exec::dispatch(&request.tool, request.args, &request.workspace_root).await
        }
        "mcp_stdio_start" | "mcp_stdio_stop" | "mcp_stdio_list_tools"
        | "mcp_stdio_call_tool" | "mcp_stop_all" => {
            tool_mcp::dispatch(&request.tool, request.args, &request.workspace_root).await
        }
        _ => tool_fs::dispatch(&request).await,
    };

    serde_json::to_string(&response).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize tool response: {e}"))
    })
}
