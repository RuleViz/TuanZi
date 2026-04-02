//! tool-exec — Process execution tools (bash).
//!
//! Provides the kernel of the bash tool: spawn a shell command, capture output,
//! handle timeout / force-kill, strip ANSI, truncate.
//!
//! Policy checks and approval gates remain in TypeScript.

pub mod bash;

use tool_protocol::{BashExecArgs, ToolResponse};

/// Dispatch an exec tool request.
pub async fn dispatch(tool: &str, args: serde_json::Value, workspace_root: &str) -> ToolResponse {
    match tool {
        "bash_exec" => match serde_json::from_value::<BashExecArgs>(args) {
            Ok(a) => bash::execute(a, workspace_root).await,
            Err(e) => ToolResponse::failure(format!("Invalid bash_exec args: {e}")),
        },
        _ => ToolResponse::failure(format!("Unknown exec tool: {tool}")),
    }
}
