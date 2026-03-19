import type { Tool } from "../core/types";
import { BrowserActionTool } from "./browser-action";
import { BashTool } from "./bash";
import { DeleteFileTool } from "./delete-file";
import { EditTool } from "./edit";
import { GlobTool } from "./glob";
import { GrepTool } from "./grep";
import { LsTool } from "./ls";
import { ReadTool } from "./read";
import { SkillLoadTool } from "./skill-load";
import { SkillReadResourceTool } from "./skill-read-resource";
import { WriteTool } from "./write";

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
    new SkillLoadTool(),
    new SkillReadResourceTool()
  ];
}
