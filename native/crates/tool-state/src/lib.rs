//! tool-state — State/snapshot persistence tools (checkpoint, agent-run, subagent-session).
//!
//! Dispatch layer that routes tool requests to the appropriate submodule.

pub mod agent_run;
pub mod checkpoint;
pub mod subagent_session;

use tool_protocol::{
    CheckpointCreateArgs, CheckpointDiffArgs, CheckpointRestoreArgs,
    CheckpointUpdateToolCallsArgs, SubagentSessionSaveArgs, AgentRunSaveArgs,
    ToolResponse,
};

/// Dispatch a state tool request by tool name and JSON args.
pub async fn dispatch(tool: &str, args: serde_json::Value, workspace_root: &str) -> ToolResponse {
    match tool {
        "checkpoint_create" => {
            match serde_json::from_value::<CheckpointCreateArgs>(args) {
                Ok(a) => checkpoint::create_checkpoint(a, workspace_root).await,
                Err(e) => ToolResponse::failure(format!("Invalid checkpoint_create args: {e}")),
            }
        }
        "checkpoint_restore" => {
            match serde_json::from_value::<CheckpointRestoreArgs>(args) {
                Ok(a) => checkpoint::restore_checkpoint(a, workspace_root).await,
                Err(e) => ToolResponse::failure(format!("Invalid checkpoint_restore args: {e}")),
            }
        }
        "checkpoint_list" => {
            checkpoint::list_checkpoints(workspace_root).await
        }
        "checkpoint_diff" => {
            match serde_json::from_value::<CheckpointDiffArgs>(args) {
                Ok(a) => checkpoint::diff_checkpoint(&a.turn_id, workspace_root).await,
                Err(e) => ToolResponse::failure(format!("Invalid checkpoint_diff args: {e}")),
            }
        }
        "checkpoint_update_tool_calls" => {
            match serde_json::from_value::<CheckpointUpdateToolCallsArgs>(args) {
                Ok(a) => checkpoint::update_tool_calls(&a.turn_id, a.tool_calls, workspace_root).await,
                Err(e) => ToolResponse::failure(format!("Invalid checkpoint_update_tool_calls args: {e}")),
            }
        }
        "agent_run_save" => {
            match serde_json::from_value::<AgentRunSaveArgs>(args) {
                Ok(a) => agent_run::save_active_run(a, workspace_root).await,
                Err(e) => ToolResponse::failure(format!("Invalid agent_run_save args: {e}")),
            }
        }
        "agent_run_load" => {
            agent_run::load_active_run(workspace_root).await
        }
        "agent_run_clear" => {
            agent_run::clear_active_run(workspace_root).await
        }
        "subagent_session_save" => {
            match serde_json::from_value::<SubagentSessionSaveArgs>(args) {
                Ok(a) => subagent_session::save_session(a, workspace_root).await,
                Err(e) => ToolResponse::failure(format!("Invalid subagent_session_save args: {e}")),
            }
        }
        "subagent_session_load" => {
            let session_id = args.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            let agent_id = args.get("agentId").and_then(|v| v.as_str()).unwrap_or("");
            if session_id.is_empty() || agent_id.is_empty() {
                ToolResponse::failure("subagent_session_load requires sessionId and agentId".to_string())
            } else {
                subagent_session::load_session(session_id, agent_id, workspace_root).await
            }
        }
        _ => ToolResponse::failure(format!("Unknown state tool: {tool}")),
    }
}
