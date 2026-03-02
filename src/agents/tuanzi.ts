import type { ToolRegistry } from "../core/tool-registry";
import { parseJsonObject } from "../core/json-utils";
import type {
  CoderResult,
  ToolCallRecord,
  ToolExecutionContext,
  ToolExecutionResult
} from "../core/types";
import type { ChatCompletionClient } from "./model-types";
import { coderSystemPrompt } from "./prompts";
import { ReactToolAgent } from "./react-tool-agent";

const ALL_CODER_TOOLS = [
  "list_dir",
  "find_by_name",
  "grep_search",
  "view_file",
  "write_to_file",
  "diff_apply",
  "delete_file",
  "codebase_search",
  "search_web",
  "fetch_url",
  "read_url_content",
  "run_command",
  "browser_action",
  "checkpoint"
];

export class TuanZiAgent {
  constructor(
    private readonly client: ChatCompletionClient | null,
    private readonly model: string | null,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolContext: ToolExecutionContext
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

    const agent = new ReactToolAgent(this.client, this.model, this.toolRegistry, this.toolContext);
    const userPromptSections = [
      "Task:",
      task
    ];
    if (conversationContext) {
      userPromptSections.push(
        "",
        "Conversation memory from previous turns (context only, lower priority than current task):",
        conversationContext
      );
    }
    userPromptSections.push(
      "",
      "You are TuanZi (团子). Handle the full task lifecycle: understand intent, inspect context if needed, use tools when required, and reply to the user in natural language."
    );
    const userPrompt = userPromptSections.join("\n");

    const output = await agent.run({
      systemPrompt: coderSystemPrompt(this.toolContext.workspaceRoot),
      userPrompt,
      allowedTools: ALL_CODER_TOOLS,
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
      "未配置模型（MYCODER_API_KEY / QWEN_API_KEY 或模型名缺失），团子进入降级模式。工具仍可使用，可通过 tools run 或补充模型配置后运行 agent。",
    changedFiles: [],
    executedCommands: [],
    followUp: [
      "设置 MYCODER_API_KEY 或 QWEN_API_KEY 与模型变量后重试 agent run。"
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
