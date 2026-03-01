import type { ToolRegistry } from "../core/tool-registry";
import { parseJsonObject } from "../core/json-utils";
import type {
  CoderResult,
  ExecutionPlan,
  SearchReference,
  ToolCallRecord,
  ToolExecutionContext,
  ToolExecutionResult
} from "../core/types";
import type { ChatCompletionClient } from "./model-types";
import { coderSystemPrompt } from "./prompts";
import { ReactToolAgent } from "./react-tool-agent";

const READ_ONLY_CODER_TOOLS = [
  "list_dir",
  "find_by_name",
  "grep_search",
  "view_file",
  "search_web",
  "fetch_url",
  "read_url_content"
];

const WRITE_ENABLED_CODER_TOOLS = [
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

export class CoderAgent {
  constructor(
    private readonly client: ChatCompletionClient | null,
    private readonly model: string | null,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolContext: ToolExecutionContext
  ) { }

  async execute(task: string, plan: ExecutionPlan, references: SearchReference[], conversationContext = ""): Promise<{
    result: CoderResult;
    toolCalls: ToolCallRecord[];
  }> {
    if (!this.client || !this.model) {
      return {
        result: fallbackCoderResult(references),
        toolCalls: []
      };
    }

    const agent = new ReactToolAgent(this.client, this.model, this.toolRegistry, this.toolContext);
    const allowWrite = taskNeedsWriteOrCommand(task);
    const allowedTools = allowWrite ? WRITE_ENABLED_CODER_TOOLS : READ_ONLY_CODER_TOOLS;
    const userPromptSections = [
      "Task:",
      task,
      "",
      "Execution Plan JSON:",
      JSON.stringify(plan, null, 2),
      "",
      "Mounted references:",
      JSON.stringify(references, null, 2)
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
      allowWrite
        ? "Use tools when needed to implement requested changes, verify if code changed, then return strict JSON summary."
        : "This is read-only or explanatory request. Avoid write/command tools. Use read/search tools only if needed, then return strict JSON summary."
    );
    const userPrompt = userPromptSections.join("\n");

    const output = await agent.run({
      systemPrompt: coderSystemPrompt(this.toolContext.workspaceRoot),
      userPrompt,
      allowedTools,
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
      return {
        result: buildCoderResultFromToolCalls(toolCalls, "Coder 完成了工具调用，但最终摘要不是 JSON。"),
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
            ? parsed.summary
            : "Coder completed with parsed JSON summary.",
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
    if (call.toolName !== "run_command" || !call.result.ok || !call.result.data) {
      continue;
    }
    if (typeof call.result.data !== "object" || Array.isArray(call.result.data)) {
      continue;
    }

    const data = call.result.data as Record<string, unknown>;
    const command = typeof data.command === "string" ? data.command : null;
    const exitCode =
      typeof data.exitCode === "number" ? data.exitCode : data.exitCode === null ? null : null;
    if (command) {
      commands.push({ command, exitCode });
    }
  }
  return commands;
}

function fallbackCoderResult(references: SearchReference[]): CoderResult {
  return {
    summary:
      "未配置模型（MYCODER_API_KEY 或模型名缺失），Coder 进入降级模式。MVP 工具已可用，可通过 tools run 或补充模型配置后运行 agent。",
    changedFiles: [],
    executedCommands: [],
    followUp: [
      "设置 MYCODER_API_KEY 与模型变量后重试 agent run。",
      `当前挂载的候选文件数: ${references.length}`
    ]
  };
}

function buildCoderResultFromToolCalls(toolCalls: ToolCallRecord[], summary: string): CoderResult {
  return {
    summary,
    changedFiles: collectChangedFiles(toolCalls),
    executedCommands: collectExecutedCommands(toolCalls),
    followUp: []
  };
}

function taskNeedsWriteOrCommand(task: string): boolean {
  const text = task.toLowerCase();
  const readOnlyHints = [
    /不要修改|不修改|无需修改|仅阅读|只读|只需要解释|只做说明|不要执行命令|不需要运行命令/,
    /\b(read[\s-]?only|do not modify|don't modify|no changes|explain only|no command)\b/
  ];
  if (readOnlyHints.some((pattern) => pattern.test(text))) {
    return false;
  }

  const writeHints = [
    /修改|修复|重构|实现|新增|删除|替换|补丁|提交|写入|创建/,
    /\b(modify|fix|refactor|implement|add|create|delete|replace|patch|write|edit|update)\b/
  ];
  return writeHints.some((pattern) => pattern.test(text));
}
