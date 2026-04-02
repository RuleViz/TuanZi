//! tool-fs: File system tool implementations (read, ls, glob, grep).

mod path_utils;
mod read;
mod ls;
mod glob;
mod grep;

pub use path_utils::{resolve_safe_path, assert_inside_workspace};
pub use read::execute_read;
pub use ls::execute_ls;
pub use glob::execute_glob;
pub use grep::execute_grep;

use tool_protocol::{ToolRequest, ToolResponse, ToolError};

/// Route a tool request to the correct handler.
pub async fn dispatch(request: &ToolRequest) -> ToolResponse {
    match request.tool.as_str() {
        "read" => match serde_json::from_value(request.args.clone()) {
            Ok(args) => execute_read(args, &request.workspace_root).await,
            Err(e) => ToolResponse::failure(format!("Invalid read args: {e}")),
        },
        "ls" => match serde_json::from_value(request.args.clone()) {
            Ok(args) => execute_ls(args, &request.workspace_root).await,
            Err(e) => ToolResponse::failure(format!("Invalid ls args: {e}")),
        },
        "glob" => match serde_json::from_value(request.args.clone()) {
            Ok(args) => execute_glob(args, &request.workspace_root).await,
            Err(e) => ToolResponse::failure(format!("Invalid glob args: {e}")),
        },
        "grep" => match serde_json::from_value(request.args.clone()) {
            Ok(args) => execute_grep(args, &request.workspace_root).await,
            Err(e) => ToolResponse::failure(format!("Invalid grep args: {e}")),
        },
        other => ToolError::UnknownTool(other.to_string()).into(),
    }
}
