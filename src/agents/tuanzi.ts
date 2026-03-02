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
  "replace_file_content",
  "delete_file",
  "search_web",
  "fetch_url",
  "read_url_content",
  "run_command"
];

export class TuanZiAgent {
  constructor(
    private readonly client: ChatCompletionClient | null,
    private readonly model: string | null,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolContext: ToolExecutionContext
  ) { }

  async execute(task: string, conversationContext = ""): Promise<{
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
      "You are TuanZi (团子). Handle the full task lifecycle: understand intent, inspect context if needed, use tools when required, and return a strict JSON summary."
    );
    const userPrompt = userPromptSections.join("\n");

    const output = await agent.run({
      systemPrompt: coderSystemPrompt(this.toolContext.workspaceRoot),
      userPrompt,
      allowedTools: ALL_CODER_TOOLS,
      maxTurns: this.toolContext.agentSettings?.toolLoop.coderMaxTurns ?? 20,
      temperature: 0.15
    });

    const parsed = parseJsonObject(output.finalText);
    const toolCalls: ToolCallRecord[] = output.toolCalls.map((call) => ({
      toolName: call.name,
      args: call.args,
      result: call.result,
      timestamp: new Date().toISOString()
    }));

    if (!parsed) {
      const fallbackSummary = output.finalText.trim()
        ? normalizeUserFacingSummary(output.finalText)
        : "TuanZi completed tool execution but returned an empty final message.";
      return {
        result: buildCoderResultFromToolCalls(toolCalls, fallbackSummary),
        toolCalls
      };
    }

    const changedFiles = Array.isArray(parsed.changedFiles)
      ? parsed.changedFiles.filter((item): item is string => typeof item === "string")
      : collectChangedFiles(toolCalls);

    const executedCommands = Array.isArray(parsed.executedCommands)
      ? parsed.executedCommands
        .map((item) => toExecutedCommand(item))
        .filter((item): item is { command: string; exitCode: number | null } => item !== null)
      : collectExecutedCommands(toolCalls);

    const followUp = Array.isArray(parsed.followUp)
      ? parsed.followUp.filter((item): item is string => typeof item === "string")
      : [];

    return {
      result: {
        summary:
          typeof parsed.summary === "string" && parsed.summary.trim()
            ? normalizeUserFacingSummary(parsed.summary)
            : "TuanZi completed with parsed JSON summary.",
        changedFiles,
        executedCommands,
        followUp
      },
      toolCalls
    };
  }
}

function toExecutedCommand(value: unknown): { command: string; exitCode: number | null } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command : null;
  const exitCode = typeof record.exitCode === "number" ? record.exitCode : record.exitCode === null ? null : null;
  if (!command) {
    return null;
  }
  return { command, exitCode };
}

function collectChangedFiles(toolCalls: ToolCallRecord[]): string[] {
  const fileTools = new Set(["write_to_file", "replace_file_content", "delete_file"]);
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

function buildCoderResultFromToolCalls(toolCalls: ToolCallRecord[], summary: string): CoderResult {
  return {
    summary: normalizeUserFacingSummary(summary),
    changedFiles: collectChangedFiles(toolCalls),
    executedCommands: collectExecutedCommands(toolCalls),
    followUp: []
  };
}

function normalizeUserFacingSummary(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const filtered = lines.filter((line) => !isMetaNarrationLine(line));
  const next = (filtered.length > 0 ? filtered.join("\n") : trimmed).trim();
  return next;
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
