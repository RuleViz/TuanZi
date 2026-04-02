//! agent_run.rs — Active agent-run snapshot persistence.
//!
//! Mirrors `AgentRunStore` from agent-run-store.ts.

use std::path::Path;
use tokio::fs;
use tool_protocol::{AgentRunSaveArgs, AgentRunSnapshot, ToolResponse};

const AGENT_RUN_DIR: &str = ".tuanzi/agent-run";
const ACTIVE_RUN_FILE: &str = "active-run.json";

fn now_iso() -> String {
    use std::time::SystemTime;
    let d = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    // Simple ISO string
    format!("{}ms", d.as_millis())
}

/// Save an active agent-run snapshot.
pub async fn save_active_run(args: AgentRunSaveArgs, workspace_root: &str) -> ToolResponse {
    let dir = Path::new(workspace_root).join(AGENT_RUN_DIR);
    if let Err(e) = fs::create_dir_all(&dir).await {
        return ToolResponse::failure(format!("Failed to create agent-run dir: {e}"));
    }

    let now = now_iso();
    let snapshot = AgentRunSnapshot {
        version: 1,
        created_at: args.created_at.unwrap_or_else(|| now.clone()),
        updated_at: now,
        status: args.status,
        workspace_root: args.workspace_root,
        model_override: args.model_override,
        agent_override: args.agent_override,
        task: args.task,
        prepared_task: args.prepared_task,
        streamed_response: args.streamed_response,
        tool_calls: args.tool_calls,
        resume_state: args.resume_state,
    };

    let file_path = dir.join(ACTIVE_RUN_FILE);
    let content = match serde_json::to_string_pretty(&snapshot) {
        Ok(c) => c,
        Err(e) => return ToolResponse::failure(format!("Serialization error: {e}")),
    };

    // Atomic write via temp file
    let tmp = format!("{}.tmp", file_path.display());
    if let Err(e) = fs::write(&tmp, format!("{content}\n")).await {
        return ToolResponse::failure(format!("Failed to write temp file: {e}"));
    }
    if let Err(e) = fs::rename(&tmp, &file_path).await {
        let _ = fs::remove_file(&tmp).await;
        return ToolResponse::failure(format!("Failed to rename temp file: {e}"));
    }

    ToolResponse::success(serde_json::json!({"ok": true}))
}

/// Load the active agent-run snapshot.
pub async fn load_active_run(workspace_root: &str) -> ToolResponse {
    let file_path = Path::new(workspace_root)
        .join(AGENT_RUN_DIR)
        .join(ACTIVE_RUN_FILE);

    let content = match fs::read_to_string(&file_path).await {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return ToolResponse::success(serde_json::Value::Null);
        }
        Err(e) => {
            return ToolResponse::failure(format!("Failed to read active run: {e}"));
        }
    };

    match serde_json::from_str::<AgentRunSnapshot>(&content) {
        Ok(snapshot) => match serde_json::to_value(&snapshot) {
            Ok(v) => ToolResponse::success(v),
            Err(e) => ToolResponse::failure(format!("Serialization error: {e}")),
        },
        Err(e) => ToolResponse::failure(format!("Failed to parse active run: {e}")),
    }
}

/// Clear (delete) the active agent-run snapshot.
pub async fn clear_active_run(workspace_root: &str) -> ToolResponse {
    let file_path = Path::new(workspace_root)
        .join(AGENT_RUN_DIR)
        .join(ACTIVE_RUN_FILE);

    match fs::remove_file(&file_path).await {
        Ok(_) => ToolResponse::success(serde_json::json!({"ok": true})),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            ToolResponse::success(serde_json::json!({"ok": true}))
        }
        Err(e) => ToolResponse::failure(format!("Failed to delete active run: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_save_args() -> AgentRunSaveArgs {
        AgentRunSaveArgs {
            status: "running".to_string(),
            workspace_root: "/test".to_string(),
            model_override: None,
            agent_override: None,
            task: "do something".to_string(),
            prepared_task: "prepared: do something".to_string(),
            streamed_response: "".to_string(),
            tool_calls: serde_json::json!([]),
            resume_state: serde_json::json!(null),
            created_at: Some("2025-01-01T00:00:00Z".to_string()),
        }
    }

    #[tokio::test]
    async fn test_save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        let save_resp = save_active_run(make_save_args(), workspace).await;
        assert!(save_resp.ok, "Save error: {:?}", save_resp.error);

        let load_resp = load_active_run(workspace).await;
        assert!(load_resp.ok);
        let loaded: AgentRunSnapshot =
            serde_json::from_value(load_resp.data.unwrap()).unwrap();
        assert_eq!(loaded.status, "running");
        assert_eq!(loaded.task, "do something");
    }

    #[tokio::test]
    async fn test_load_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        let resp = load_active_run(workspace).await;
        assert!(resp.ok);
        assert_eq!(resp.data.unwrap(), serde_json::Value::Null);
    }

    #[tokio::test]
    async fn test_clear() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        save_active_run(make_save_args(), workspace).await;

        let clear_resp = clear_active_run(workspace).await;
        assert!(clear_resp.ok);

        // Load should return null
        let load_resp = load_active_run(workspace).await;
        assert!(load_resp.ok);
        assert_eq!(load_resp.data.unwrap(), serde_json::Value::Null);
    }

    #[tokio::test]
    async fn test_clear_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        let resp = clear_active_run(workspace).await;
        assert!(resp.ok);
    }
}
