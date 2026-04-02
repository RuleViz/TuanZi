//! tool-protocol: shared request/response types between TypeScript and Rust.
//!
//! This crate defines the JSON-serializable structures that cross the FFI boundary.

use serde::{Deserialize, Serialize};

/// A tool execution request coming from TypeScript.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolRequest {
    /// Tool name, e.g. "read", "ls", "glob", "grep"
    pub tool: String,
    /// Tool-specific arguments as a JSON object
    pub args: serde_json::Value,
    /// Workspace root path (absolute)
    pub workspace_root: String,
}

/// A tool execution response going back to TypeScript.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ToolResponse {
    pub fn success(data: serde_json::Value) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(error.into()),
        }
    }
}

/// Errors that can occur during tool execution.
#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("Unknown tool: {0}")]
    UnknownTool(String),

    #[error("Invalid arguments: {0}")]
    InvalidArgs(String),

    #[error("Path outside workspace: {path}")]
    PathOutsideWorkspace { path: String },

    #[error("File not found: {0}")]
    FileNotFound(String),

    #[error("Directory not found: {0}")]
    DirectoryNotFound(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Invalid regex: {0}")]
    InvalidRegex(String),

    #[error("{0}")]
    Other(String),
}

impl From<ToolError> for ToolResponse {
    fn from(err: ToolError) -> Self {
        ToolResponse::failure(err.to_string())
    }
}

// ── Read tool types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadArgs {
    pub path: String,
    #[serde(default)]
    pub offset: Option<u64>,
    #[serde(default)]
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadResult {
    pub content: String,
    pub file: ReadFileInfo,
    pub metadata: ReadMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadFileInfo {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadMetadata {
    pub total_lines: usize,
    pub file_size: u64,
    pub offset: usize,
    pub limit: Option<u64>,
    pub returned_lines: usize,
    pub viewed_range: String,
    pub has_more: bool,
    pub next_offset: Option<usize>,
}

// ── Ls tool types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LsArgs {
    pub path: String,
    #[serde(default)]
    pub limit: Option<u64>,
    #[serde(default)]
    pub show_hidden: Option<bool>,
    #[serde(default)]
    pub pattern: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LsResult {
    pub content: String,
    pub total: usize,
    pub truncated: bool,
    pub entries: Vec<LsEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LsEntry {
    pub path: String,
    pub is_directory: bool,
    pub depth: u32,
}

// ── Glob tool types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobArgs {
    pub search_path: String,
    pub pattern: String,
    #[serde(default)]
    pub max_results: Option<u64>,
    #[serde(default)]
    pub max_depth: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobResult {
    pub search_path: String,
    pub pattern: String,
    pub total: usize,
    pub truncated: bool,
    pub matches: Vec<GlobMatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobMatch {
    pub absolute_path: String,
    pub relative_path: String,
    pub is_directory: bool,
    pub size_bytes: u64,
}

// ── Grep tool types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrepArgs {
    pub search_path: String,
    pub query: String,
    #[serde(default)]
    pub is_regex: Option<bool>,
    #[serde(default)]
    pub case_sensitive: Option<bool>,
    #[serde(default)]
    pub includes: Option<Vec<String>>,
    #[serde(default)]
    pub max_results: Option<u64>,
    #[serde(default)]
    pub context_lines: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrepResult {
    pub query: String,
    pub total: usize,
    pub truncated: bool,
    pub hits: Vec<GrepHit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepHit {
    pub file: String,
    pub line_number: usize,
    pub line_content: String,
    pub before: Vec<String>,
    pub after: Vec<String>,
}

// ── Write tool types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteArgs {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub path: String,
    pub bytes_written: u64,
    pub backup_path: Option<String>,
}

// ── Edit tool types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditArgs {
    pub target_file: String,
    pub diff: String,
    #[serde(default)]
    pub fuzz: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditResult {
    pub path: String,
    pub hunks_applied: usize,
    pub lines_changed: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

// ── Delete tool types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteArgs {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub deleted_path: String,
    /// "file" or "directory"
    pub entry_type: String,
    pub backup_path: Option<String>,
}

// ── Checkpoint types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointCreateArgs {
    pub turn_id: String,
    pub turn_index: usize,
    pub user_message: String,
    #[serde(default)]
    pub max_checkpoints: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRestoreArgs {
    pub turn_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointUpdateToolCallsArgs {
    pub turn_id: String,
    pub tool_calls: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiffArgs {
    pub turn_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCheckpoint {
    pub id: String,
    pub turn_index: usize,
    pub user_message: String,
    pub created_at: String,
    pub tool_calls: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointIndex {
    pub version: u32,
    pub checkpoints: Vec<TurnCheckpoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointManifest {
    pub files: std::collections::HashMap<String, ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub hash: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub restored_files: usize,
    pub removed_files: usize,
}

// ── AgentRun types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunSaveArgs {
    pub status: String,
    pub workspace_root: String,
    pub model_override: Option<String>,
    pub agent_override: Option<String>,
    pub task: String,
    pub prepared_task: String,
    pub streamed_response: String,
    pub tool_calls: serde_json::Value,
    pub resume_state: serde_json::Value,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunSnapshot {
    pub version: u32,
    pub created_at: String,
    pub updated_at: String,
    pub status: String,
    pub workspace_root: String,
    pub model_override: Option<String>,
    pub agent_override: Option<String>,
    pub task: String,
    pub prepared_task: String,
    pub streamed_response: String,
    pub tool_calls: serde_json::Value,
    pub resume_state: serde_json::Value,
}

// ── SubagentSession types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentSessionSaveArgs {
    pub session_id: String,
    pub agent_id: String,
    pub task: String,
    pub context: String,
    pub conversation_snapshot: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentSessionSnapshot {
    pub version: u32,
    pub session_id: String,
    pub agent_id: String,
    pub task: String,
    pub context: String,
    pub created_at: String,
    pub updated_at: String,
    pub conversation_snapshot: serde_json::Value,
}

// ── Bash execution types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BashExecArgs {
    pub command: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub max_output_chars: Option<u64>,
    #[serde(default)]
    pub env: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BashExecResult {
    pub command: String,
    pub cwd: String,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub timed_out: bool,
    pub interrupted: bool,
    pub force_killed: bool,
    pub duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub is_dangerous: bool,
}

// ── MCP transport types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioStartArgs {
    pub server_id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    #[serde(default = "default_mcp_timeout")]
    pub startup_timeout_ms: u64,
    #[serde(default = "default_mcp_timeout")]
    pub request_timeout_ms: u64,
}

fn default_mcp_timeout() -> u64 {
    30000
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStopArgs {
    pub server_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallToolArgs {
    pub server_id: String,
    pub tool_name: String,
    #[serde(default)]
    pub arguments: serde_json::Value,
    #[serde(default = "default_mcp_timeout")]
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpListToolsArgs {
    pub server_id: String,
    #[serde(default = "default_mcp_timeout")]
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}
