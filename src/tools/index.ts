import type { Tool } from "../core/types";
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
import { WaitSubagentsTool } from "./wait-subagents";
import { WriteTool } from "./write";
import { AskUserQuestionTool } from "./ask-user-question";

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
    new WaitSubagentsTool(),
    new ListSubagentsTool(),
    new SkillListTool(),
    new SkillLoadTool(),
    new SkillReadResourceTool(),
    new AskUserQuestionTool()
  ];
}
