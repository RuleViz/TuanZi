import type { ToolRegistry } from "../core/tool-registry";
import { parseJsonObject } from "../core/json-utils";
import type {
  CoderResult,
  ToolCallRecord,
  ToolExecutionContext,
  ToolExecutionResult
} from "../core/types";
import type { GlobalSkillsConfig, StoredAgent } from "../core/agent-store";
import { resolveActiveTools } from "../core/agent-tooling";
import type { ChatCompletionClient } from "./model-types";
import { coderSystemPrompt } from "./prompts";
import { ReactToolAgent } from "./react-tool-agent";

export class TuanZiAgent {
  constructor(
    private readonly client: ChatCompletionClient | null,
    private readonly model: string | null,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolContext: ToolExecutionContext,
    private readonly activeAgent: StoredAgent,
    private readonly globalSkills: GlobalSkillsConfig
  ) { }

  async execute(
    task: string,
    conversationContext = "",
    hooks?: { onAssistantTextDelta?: (delta: string) => void }
  ): Promise<{
    result: CoderResult;
    toolCalls: ToolCallRecord[];
  }> {
    if (!this.client || !this.model) {
      return {
        result: fallbackCoderResult(),
        toolCalls: []
      };
    }

    const availableToolNames = this.toolRegistry.getToolNames();
    const activeTools = resolveActiveTools(this.activeAgent.tools, this.globalSkills, availableToolNames);
    this.toolContext.logger.info(
      `[agent] profile=${this.activeAgent.filename} activeTools=${activeTools.activeToolNames.length}`
    );

    const agent = new ReactToolAgent(this.client, this.model, this.toolRegistry, this.toolContext);
    const userPromptSections = [
      "Task:",
      task,
      "",
      `Active agent: ${this.activeAgent.name}`,
      this.activeAgent.description ? `Agent description: ${this.activeAgent.description}` : ""
    ].filter((line) => line !== "");

    if (conversationContext) {
      userPromptSections.push(
        "",
        "Conversation memory from previous turns (context only, lower priority than current task):",
        conversationContext
      );
    }
    userPromptSections.push(
      "",
      "Handle the full task lifecycle: understand intent, inspect context if needed, use tools when required, and reply to the user in natural language.",
      "Output style requirement: keep wording professional and avoid unnecessary decorative symbols unless the user explicitly requests that style."
    );
    const userPrompt = userPromptSections.join("\n");

    const output = await agent.run({
      systemPrompt: coderSystemPrompt({
        workspaceRoot: this.toolContext.workspaceRoot,
        agentName: this.activeAgent.name,
        agentPrompt: this.activeAgent.prompt,
        toolInstructions: activeTools.activeTools.map((tool) => ({
          name: tool.name,
          prompt: tool.prompt
        }))
      }),
      userPrompt,
      allowedTools: activeTools.activeToolNames,
      maxTurns: this.toolContext.agentSettings?.toolLoop.coderMaxTurns ?? 20,
      temperature: 0.15,
      onAssistantTextDelta: hooks?.onAssistantTextDelta
    });

    const toolCalls: ToolCallRecord[] = output.toolCalls.map((call) => ({
      toolName: call.name,
      args: call.args,
      result: call.result,
      timestamp: new Date().toISOString()
    }));
    const summary = extractUserFacingText(output.finalText);

    return {
      result: {
        summary,
        changedFiles: collectChangedFiles(toolCalls),
        executedCommands: collectExecutedCommands(toolCalls),
        followUp: []
      },
      toolCalls
    };
  }
}

function collectChangedFiles(toolCalls: ToolCallRecord[]): string[] {
  const fileTools = new Set(["write_to_file", "diff_apply", "delete_file"]);
  const paths = new Set<string>();

  for (const call of toolCalls) {
    if (!fileTools.has(call.toolName)) {
      continue;
    }
    if (!call.result.ok || !call.result.data || typeof call.result.data !== "object" || Array.isArray(call.result.data)) {
      continue;
    }

    const data = call.result.data as Record<string, unknown>;
    const possiblePathKeys = ["path", "targetFile", "deletedPath"];
    for (const key of possiblePathKeys) {
      const value = data[key];
      if (typeof value === "string") {
        paths.add(value);
      }
    }
  }

  return [...paths];
}

function collectExecutedCommands(toolCalls: ToolCallRecord[]): Array<{ command: string; exitCode: number | null }> {
  const commands: Array<{ command: string; exitCode: number | null }> = [];
  for (const call of toolCalls) {
    if (call.toolName !== "run_command") {
      continue;
    }
    const commandFromArgs = typeof call.args.command === "string" ? call.args.command : null;
    let commandFromData: string | null = null;
    let exitCode: number | null = null;

    if (call.result.data && typeof call.result.data === "object" && !Array.isArray(call.result.data)) {
      const data = call.result.data as Record<string, unknown>;
      commandFromData = typeof data.command === "string" ? data.command : null;
      exitCode = typeof data.exitCode === "number" ? data.exitCode : null;
    }
    const command = commandFromData ?? commandFromArgs;
    if (command) {
      commands.push({ command, exitCode });
    }
  }
  return commands;
}

function fallbackCoderResult(): CoderResult {
  return {
    summary:
      "未配置模型（未命中 ~/.tuanzi/models.json 的 defaultModel 或会话别名，且 ~/.tuanzi/config.json provider 未配置），团子进入降级模式。",
    changedFiles: [],
    executedCommands: [],
    followUp: [
      "在 chat 里使用 /model add 和 /model use 设置模型，或配置 ~/.tuanzi/config.json 的 provider 后重试。"
    ]
  };
}

function extractUserFacingText(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return "TuanZi completed but returned an empty response.";
  }

  const maybeJsonSummary = tryExtractJsonSummary(trimmed);
  const source = maybeJsonSummary ?? trimmed;
  const lines = source.split(/\r?\n/);
  const filtered = lines.filter((line) => !isMetaNarrationLine(line.trim()));
  return (filtered.length > 0 ? filtered.join("\n") : source).trim();
}

function tryExtractJsonSummary(text: string): string | null {
  const parsed = parseJsonObject(text);
  if (!parsed || typeof parsed.summary !== "string" || !parsed.summary.trim()) {
    return null;
  }
  return parsed.summary;
}

function isMetaNarrationLine(line: string): boolean {
  const patterns = [
    /^用户(发送了|询问了|提问了|要求|请求)/,
    /^我已(经)?(友好回应|回复|完成|准备)/,
    /^这是(我|系统).*(记录|总结)/,
    /^以下是(对话|聊天).*(记录|总结)/
  ];
  return patterns.some((pattern) => pattern.test(line));
}
