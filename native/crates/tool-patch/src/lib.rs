//! tool-patch: Write, edit, and delete tool implementations.
//!
//! This crate handles all file-modification operations:
//! - `write`: Full file content replacement with backup
//! - `edit`: Apply unified diff patches with fuzzy matching
//! - `delete_file`: Delete files or empty directories with backup

mod atomic;
mod backup;
mod diff;
mod preview;
mod write;
mod edit;
mod delete;

pub use write::execute_write;
pub use edit::execute_edit;
pub use delete::execute_delete;

use tool_protocol::{ToolRequest, ToolResponse, ToolError};

/// Route a write/edit/delete tool request to the correct handler.
pub async fn dispatch(request: &ToolRequest) -> ToolResponse {
    match request.tool.as_str() {
        "write" => match serde_json::from_value(request.args.clone()) {
            Ok(args) => execute_write(args, &request.workspace_root).await,
            Err(e) => ToolResponse::failure(format!("Invalid write args: {e}")),
        },
        "edit" => match serde_json::from_value(request.args.clone()) {
            Ok(args) => execute_edit(args, &request.workspace_root).await,
            Err(e) => ToolResponse::failure(format!("Invalid edit args: {e}")),
        },
        "delete_file" => match serde_json::from_value(request.args.clone()) {
            Ok(args) => execute_delete(args, &request.workspace_root).await,
            Err(e) => ToolResponse::failure(format!("Invalid delete_file args: {e}")),
        },
        other => ToolError::UnknownTool(other.to_string()).into(),
    }
}
