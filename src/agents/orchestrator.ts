import { randomUUID } from "node:crypto";
import { AgentContextStore } from "../core/context-store";
import type { ExecutionPlan, RoutingSettings, SearchResult, ToolCallRecord, ToolExecutionContext } from "../core/types";
import { CoderAgent } from "./coder-agent";
import type { ChatCompletionClient } from "./model-types";
import { PlannerAgent } from "./planner-agent";
import { SearcherAgent } from "./searcher-agent";

export interface OrchestrationResult {
  mode: "workflow" | "direct";
  plan: ExecutionPlan;
  search: SearchResult;
  coder: {
    summary: string;
    changedFiles: string[];
    executedCommands: Array<{ command: string; exitCode: number | null }>;
    followUp: string[];
  };
  toolCalls: ToolCallRecord[];
}

export interface ConversationMemoryTurn {
  user: string;
  assistant: string;
}

export interface OrchestratorRunInput {
  task: string;
  memoryTurns?: ConversationMemoryTurn[];
}

export class PlanToDoOrchestrator {
  private readonly plannerContext = new AgentContextStore();
  private readonly searchContext = new AgentContextStore();
  private readonly coderContext = new AgentContextStore();

  constructor(
    private readonly planner: PlannerAgent,
    private readonly searcher: SearcherAgent,
    private readonly coder: CoderAgent,
    private readonly directClient: ChatCompletionClient | null,
    private readonly directModel: string | null,
    private readonly routingSettings: RoutingSettings,
    private readonly toolContext: ToolExecutionContext
  ) {}

  async run(input: string | OrchestratorRunInput): Promise<OrchestrationResult> {
    const { task, memoryTurns } = normalizeRunInput(input);
    const conversationContext = buildConversationContext(memoryTurns);

    this.toolContext.taskId = randomUUID();
    if (shouldUseDirectAnswer(task, this.routingSettings) && this.directClient && this.directModel) {
      const directSummary = await this.answerDirectly(task, conversationContext);
      return {
        mode: "direct",
        plan: {
          goal: "Direct Q&A response without file/tool workflow",
          steps: [
            {
              id: "D1",
              title: "Answer user request directly",
              owner: "code",
              acceptance: "Provide a concise helpful answer without tool calls."
            }
          ]
        },
        search: {
          summary: "Skipped search phase for direct Q&A request.",
          references: [],
          webReferences: []
        },
        coder: {
          summary: directSummary,
          changedFiles: [],
          executedCommands: [],
          followUp: []
        },
        toolCalls: []
      };
    }

    this.plannerContext.append({ role: "user", content: task });
    const plan = await this.planner.buildPlan(task, conversationContext);
    this.plannerContext.append({ role: "assistant", content: JSON.stringify(plan) });

    this.searchContext.append({
      role: "user",
      content: JSON.stringify({
        task,
        plan
      })
    });
    const search = await this.searcher.search(task, plan, conversationContext);
    this.searchContext.append({ role: "assistant", content: JSON.stringify(search) });

    for (const reference of search.references) {
      this.coderContext.mountPath(reference.path);
    }
    this.coderContext.append({
      role: "user",
      content: JSON.stringify({
        task,
        plan,
        mountedPaths: this.coderContext.getMountedPaths()
      })
    });

    const coderOutput = await this.coder.execute(task, plan, search.references, conversationContext);
    this.coderContext.append({ role: "assistant", content: JSON.stringify(coderOutput.result) });

    return {
      mode: "workflow",
      plan,
      search,
      coder: coderOutput.result,
      toolCalls: coderOutput.toolCalls
    };
  }

  private async answerDirectly(task: string, conversationContext: string): Promise<string> {
    const messages: Array<{ role: "system" | "user"; content: string }> = [
      {
        role: "system",
        content:
          "You are MyCoderAgent assistant. For pure Q&A requests, answer directly and do not use tools. Keep response concise and practical."
      }
    ];

    if (conversationContext) {
      messages.push({
        role: "user",
        content: [
          "Conversation memory from previous turns (context only, lower priority than current request):",
          conversationContext
        ].join("\n")
      });
    }
    messages.push({
      role: "user",
      content: `Current request:\n${task}`
    });

    const completion = await this.directClient!.complete({
      model: this.directModel!,
      temperature: 0.3,
      messages
    });
    const text = completion.message.content?.trim();
    return text && text.length > 0 ? text : "I do not have enough information to answer that directly.";
  }
}

function normalizeRunInput(input: string | OrchestratorRunInput): OrchestratorRunInput {
  if (typeof input === "string") {
    return { task: input };
  }
  return {
    task: input.task,
    memoryTurns: input.memoryTurns
  };
}

function normalizeMemoryText(text: string, maxLen: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, maxLen)}...`;
}

export function buildConversationContext(
  memoryTurns: ConversationMemoryTurn[] | undefined,
  options?: { maxTurns?: number; maxChars?: number }
): string {
  if (!memoryTurns || memoryTurns.length === 0) {
    return "";
  }

  const maxTurns = options?.maxTurns ?? 8;
  const maxChars = options?.maxChars ?? 6000;
  const recentTurns = memoryTurns.slice(-maxTurns);
  const chunks: string[] = [];
  let totalChars = 0;

  for (let index = recentTurns.length - 1; index >= 0; index -= 1) {
    const turn = recentTurns[index];
    const user = normalizeMemoryText(turn.user, 800);
    const assistant = normalizeMemoryText(turn.assistant, 1200);
    if (!user && !assistant) {
      continue;
    }

    const turnText = [
      `Turn ${index + 1}:`,
      user ? `User: ${user}` : "",
      assistant ? `Assistant: ${assistant}` : ""
    ]
      .filter(Boolean)
      .join("\n");

    if (chunks.length > 0 && totalChars + turnText.length + 2 > maxChars) {
      break;
    }

    chunks.unshift(turnText);
    totalChars += turnText.length + 2;
  }

  return chunks.join("\n\n");
}

export function shouldUseDirectAnswer(task: string, routingSettings: RoutingSettings): boolean {
  if (!routingSettings.enableDirectMode) {
    return false;
  }

  const normalized = task.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  if (routingSettings.directIntentPatterns.some((pattern) => normalized.includes(pattern.toLowerCase()))) {
    return true;
  }

  const codeWorkflowHints = [
    /代码|文件|函数|类|修复|修改|重构|测试|编译|运行命令|命令|目录|路径|diff|补丁|实现|开发|readme|tsconfig|工具调用|项目源码/,
    /\b(code|file|files|function|class|fix|bug|refactor|test|build|compile|command|run|path|repo|repository|patch|diff)\b/i,
    /[`$][\w./\\-]+/, // likely path/shell/code-like token
    /[/\\][\w.-]+/
  ];

  return !codeWorkflowHints.some((pattern) => pattern.test(task));
}
