//! tool-mcp — MCP transport layer (stdio client with stateful process registry).
//!
//! Provides a global registry of MCP stdio clients that can be started, stopped,
//! and used for tool calls/listing from the napi bridge.

pub mod framing;
pub mod stdio;

use std::collections::HashMap;
use std::sync::OnceLock;
use tokio::sync::Mutex;

use tool_protocol::{
    McpCallToolArgs, McpListToolsArgs, McpStdioStartArgs, McpStopArgs, McpToolInfo, ToolResponse,
};

use stdio::StdioClient;

// ── Global client registry ──

struct McpRegistry {
    clients: HashMap<String, StdioClient>,
}

static REGISTRY: OnceLock<Mutex<McpRegistry>> = OnceLock::new();

fn registry() -> &'static Mutex<McpRegistry> {
    REGISTRY.get_or_init(|| {
        Mutex::new(McpRegistry {
            clients: HashMap::new(),
        })
    })
}

/// Dispatch an MCP transport tool request.
pub async fn dispatch(tool: &str, args: serde_json::Value, _workspace_root: &str) -> ToolResponse {
    match tool {
        "mcp_stdio_start" => match serde_json::from_value::<McpStdioStartArgs>(args) {
            Ok(a) => start_stdio(a).await,
            Err(e) => ToolResponse::failure(format!("Invalid mcp_stdio_start args: {e}")),
        },
        "mcp_stdio_stop" => match serde_json::from_value::<McpStopArgs>(args) {
            Ok(a) => stop_stdio(a).await,
            Err(e) => ToolResponse::failure(format!("Invalid mcp_stdio_stop args: {e}")),
        },
        "mcp_stdio_list_tools" => match serde_json::from_value::<McpListToolsArgs>(args) {
            Ok(a) => list_tools(a).await,
            Err(e) => ToolResponse::failure(format!("Invalid mcp_stdio_list_tools args: {e}")),
        },
        "mcp_stdio_call_tool" => match serde_json::from_value::<McpCallToolArgs>(args) {
            Ok(a) => call_tool(a).await,
            Err(e) => ToolResponse::failure(format!("Invalid mcp_stdio_call_tool args: {e}")),
        },
        "mcp_stop_all" => stop_all().await,
        _ => ToolResponse::failure(format!("Unknown MCP tool: {tool}")),
    }
}

async fn start_stdio(args: McpStdioStartArgs) -> ToolResponse {
    let mut reg = registry().lock().await;

    // Stop existing client with the same ID
    if let Some(old) = reg.clients.remove(&args.server_id) {
        let _ = old.stop().await;
    }

    match StdioClient::start(
        &args.command,
        &args.args,
        &args.env,
        args.startup_timeout_ms,
        args.request_timeout_ms,
    )
    .await
    {
        Ok(client) => {
            reg.clients.insert(args.server_id.clone(), client);
            ToolResponse::success(serde_json::json!({
                "serverId": args.server_id,
                "started": true
            }))
        }
        Err(e) => ToolResponse::failure(format!("Failed to start MCP server '{}': {e}", args.server_id)),
    }
}

async fn stop_stdio(args: McpStopArgs) -> ToolResponse {
    let mut reg = registry().lock().await;
    if let Some(client) = reg.clients.remove(&args.server_id) {
        let _ = client.stop().await;
        ToolResponse::success(serde_json::json!({"stopped": true}))
    } else {
        ToolResponse::failure(format!(
            "MCP server '{}' not found.",
            args.server_id
        ))
    }
}

async fn list_tools(args: McpListToolsArgs) -> ToolResponse {
    let reg = registry().lock().await;
    let client = match reg.clients.get(&args.server_id) {
        Some(c) => c,
        None => {
            return ToolResponse::failure(format!(
                "MCP server '{}' not found. Call mcp_stdio_start first.",
                args.server_id
            ))
        }
    };

    match client.list_tools(Some(args.timeout_ms)).await {
        Ok(tools) => {
            let infos: Vec<McpToolInfo> = tools
                .iter()
                .filter_map(|t| {
                    Some(McpToolInfo {
                        name: t.get("name")?.as_str()?.to_string(),
                        description: t
                            .get("description")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        input_schema: t
                            .get("inputSchema")
                            .cloned()
                            .unwrap_or(serde_json::json!({"type": "object", "properties": {}})),
                    })
                })
                .collect();

            match serde_json::to_value(&infos) {
                Ok(v) => ToolResponse::success(v),
                Err(e) => ToolResponse::failure(format!("Serialization error: {e}")),
            }
        }
        Err(e) => ToolResponse::failure(e),
    }
}

async fn call_tool(args: McpCallToolArgs) -> ToolResponse {
    let reg = registry().lock().await;
    let client = match reg.clients.get(&args.server_id) {
        Some(c) => c,
        None => {
            return ToolResponse::failure(format!(
                "MCP server '{}' not found. Call mcp_stdio_start first.",
                args.server_id
            ))
        }
    };

    match client
        .call_tool(&args.tool_name, args.arguments, Some(args.timeout_ms))
        .await
    {
        Ok(result) => ToolResponse::success(result),
        Err(e) => ToolResponse::failure(e),
    }
}

async fn stop_all() -> ToolResponse {
    let mut reg = registry().lock().await;
    for (_, client) in reg.clients.drain() {
        let _ = client.stop().await;
    }
    ToolResponse::success(serde_json::json!({"stopped": true}))
}
