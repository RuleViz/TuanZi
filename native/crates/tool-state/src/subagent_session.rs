//! subagent_session.rs — Subagent session snapshot persistence.
//!
//! Mirrors `SubagentSessionStore` from subagent-session-store.ts.

use std::path::Path;
use tokio::fs;
use tool_protocol::{SubagentSessionSaveArgs, SubagentSessionSnapshot, ToolResponse};

const SUBAGENT_DIR: &str = ".tuanzi/subagent-snapshots";

/// Save a subagent session snapshot.
pub async fn save_session(args: SubagentSessionSaveArgs, workspace_root: &str) -> ToolResponse {
    let session_dir = Path::new(workspace_root)
        .join(SUBAGENT_DIR)
        .join(&args.session_id);

    if let Err(e) = fs::create_dir_all(&session_dir).await {
        return ToolResponse::failure(format!("Failed to create session dir: {e}"));
    }

    let file_path = session_dir.join(format!("{}.json", args.agent_id));

    let now = {
        use std::time::SystemTime;
        let d = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default();
        format!("{}ms", d.as_millis())
    };
    let snapshot = SubagentSessionSnapshot {
        version: 1,
        session_id: args.session_id,
        agent_id: args.agent_id,
        task: args.task,
        context: args.context,
        created_at: now.clone(),
        updated_at: now,
        conversation_snapshot: args.conversation_snapshot,
    };

    let content = match serde_json::to_string_pretty(&snapshot) {
        Ok(c) => c,
        Err(e) => return ToolResponse::failure(format!("Serialization error: {e}")),
    };

    // Atomic write
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

/// Load a subagent session snapshot.
pub async fn load_session(
    session_id: &str,
    agent_id: &str,
    workspace_root: &str,
) -> ToolResponse {
    let file_path = Path::new(workspace_root)
        .join(SUBAGENT_DIR)
        .join(session_id)
        .join(format!("{agent_id}.json"));

    let content = match fs::read_to_string(&file_path).await {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return ToolResponse::success(serde_json::Value::Null);
        }
        Err(e) => {
            return ToolResponse::failure(format!("Failed to read session: {e}"));
        }
    };

    match serde_json::from_str::<SubagentSessionSnapshot>(&content) {
        Ok(snapshot) => match serde_json::to_value(&snapshot) {
            Ok(v) => ToolResponse::success(v),
            Err(e) => ToolResponse::failure(format!("Serialization error: {e}")),
        },
        Err(e) => ToolResponse::failure(format!("Failed to parse session: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_save_args(session_id: &str, agent_id: &str) -> SubagentSessionSaveArgs {
        SubagentSessionSaveArgs {
            session_id: session_id.to_string(),
            agent_id: agent_id.to_string(),
            task: "find something".to_string(),
            context: "project context".to_string(),
            conversation_snapshot: serde_json::json!([
                {"role": "system", "content": "You are a subagent."},
                {"role": "user", "content": "Find something."}
            ]),
        }
    }

    #[tokio::test]
    async fn test_save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        let args = make_save_args("sess-42", "explorer");
        let save_resp = save_session(args, workspace).await;
        assert!(save_resp.ok, "Save error: {:?}", save_resp.error);

        let load_resp = load_session("sess-42", "explorer", workspace).await;
        assert!(load_resp.ok);
        let loaded: SubagentSessionSnapshot =
            serde_json::from_value(load_resp.data.unwrap()).unwrap();
        assert_eq!(loaded.agent_id, "explorer");
        assert_eq!(loaded.session_id, "sess-42");
    }

    #[tokio::test]
    async fn test_load_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        let resp = load_session("nonexistent", "agent", workspace).await;
        assert!(resp.ok);
        assert_eq!(resp.data.unwrap(), serde_json::Value::Null);
    }

    #[tokio::test]
    async fn test_multiple_agents_same_session() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();

        save_session(make_save_args("sess-1", "agent-a"), workspace).await;
        save_session(make_save_args("sess-1", "agent-b"), workspace).await;

        // Load each independently
        let resp_a = load_session("sess-1", "agent-a", workspace).await;
        let loaded_a: SubagentSessionSnapshot =
            serde_json::from_value(resp_a.data.unwrap()).unwrap();
        assert_eq!(loaded_a.agent_id, "agent-a");

        let resp_b = load_session("sess-1", "agent-b", workspace).await;
        let loaded_b: SubagentSessionSnapshot =
            serde_json::from_value(resp_b.data.unwrap()).unwrap();
        assert_eq!(loaded_b.agent_id, "agent-b");
    }
}
