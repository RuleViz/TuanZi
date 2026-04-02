import type { Tool } from "../core/types";
import { wrapWithRustFallback, tryLoadNativeModule } from "../core/rust-tool-bridge";
import { BrowserActionTool } from "./browser-action";
import { BashTool } from "./bash";
import { DeleteFileTool } from "./delete-file";
import { EditTool } from "./edit";
import { GlobTool } from "./glob";
import { GrepTool } from "./grep";
import { LsTool } from "./ls";
import { ReadTool } from "./read";
import { ListSubagentsTool } from "./list-subagents";
import { SkillLoadTool } from "./skill-load";
import { SkillListTool } from "./skill-list";
import { SkillReadResourceTool } from "./skill-read-resource";
import { SpawnSubagentTool } from "./spawn-subagent";
import { ResumeSubagentTool } from "./resume-subagent";
import { WaitSubagentsTool } from "./wait-subagents";
import { WriteTool } from "./write";
import { AskUserQuestionTool } from "./ask-user-question";

// Attempt to load the Rust native module at import time.
// Failure is silent — the bridge falls back to TS automatically.
tryLoadNativeModule();

/** Tools eligible for Rust native acceleration. */
const RUST_ELIGIBLE = new Set(["read", "ls", "glob", "grep", "write", "edit", "delete_file", "checkpoint_create", "checkpoint_restore", "checkpoint_list", "checkpoint_diff", "checkpoint_update_tool_calls", "agent_run_save", "agent_run_load", "agent_run_clear", "subagent_session_save", "subagent_session_load"]);

function maybeWrap(tool: Tool): Tool {
  return RUST_ELIGIBLE.has(tool.definition.name) ? wrapWithRustFallback(tool) : tool;
}

export function createDefaultTools(): Tool[] {
  return [
    new LsTool(),
    new ReadTool(),
    new WriteTool(),
    new DeleteFileTool(),
    new GlobTool(),
    new GrepTool(),
    new BashTool(),
    new EditTool(),
    new BrowserActionTool(),
    new SpawnSubagentTool(),
    new ResumeSubagentTool(),
    new WaitSubagentsTool(),
    new ListSubagentsTool(),
    new SkillListTool(),
    new SkillLoadTool(),
    new SkillReadResourceTool(),
    new AskUserQuestionTool()
  ].map(maybeWrap);
}
