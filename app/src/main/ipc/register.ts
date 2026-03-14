import { registerAgentHandlers, type AgentHandlersDeps } from "./agent-handlers";
import { registerChatHandlers, type ChatHandlersDeps } from "./chat-handlers";
import { registerMcpHandlers, type McpHandlersDeps } from "./mcp-handlers";
import { registerSkillHandlers, type SkillHandlersDeps } from "./skill-handlers";
import { registerWindowHandlers, type WindowHandlersDeps } from "./window-handlers";

export interface IpcRegisterDeps {
  window: WindowHandlersDeps;
  chat: ChatHandlersDeps;
  agent: AgentHandlersDeps;
  skills: SkillHandlersDeps;
  mcp: McpHandlersDeps;
}

export function registerIpcHandlers(deps: IpcRegisterDeps): void {
  registerWindowHandlers(deps.window);
  registerChatHandlers(deps.chat);
  registerAgentHandlers(deps.agent);
  registerSkillHandlers(deps.skills);
  registerMcpHandlers(deps.mcp);
}
