import type { Tool } from "../core/types";
import { BrowserActionTool } from "./browser-action";
import { CheckpointTool } from "./checkpoint";
import { CodebaseSearchTool } from "./codebase-search";
import { DeleteFileTool } from "./delete-file";
import { DiffApplyTool } from "./diff-apply";
import { FindByNameTool } from "./find-by-name";
import { GrepSearchTool } from "./grep-search";
import { ListDirTool } from "./list-dir";
import { RunCommandTool } from "./run-command";
import { SkillLoadTool } from "./skill-load";
import { SkillReadResourceTool } from "./skill-read-resource";
import { ViewFileTool } from "./view-file";
import { WriteToFileTool } from "./write-to-file";

export function createDefaultTools(): Tool[] {
  return [
    new ListDirTool(),
    new ViewFileTool(),
    new WriteToFileTool(),
    new DeleteFileTool(),
    new FindByNameTool(),
    new GrepSearchTool(),
    new RunCommandTool(),
    new DiffApplyTool(),
    new CodebaseSearchTool(),
    new BrowserActionTool(),
    new CheckpointTool(),
    new SkillLoadTool(),
    new SkillReadResourceTool()
  ];
}
