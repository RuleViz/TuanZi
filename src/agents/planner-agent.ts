import { randomUUID } from "node:crypto";
import type { ToolRegistry } from "../core/tool-registry";
import type { ExecutionPlan, PlanStep, ToolCallRecord, ToolExecutionContext } from "../core/types";
import { parseJsonObject } from "../core/json-utils";
import type { ChatCompletionClient } from "./model-types";
import { plannerSystemPrompt } from "./prompts";
import { buildInitialPromptTokenBudget, loadProjectContextFromWorkspace } from "./project-context";
import { ReactToolAgent, type ToolLoopToolCallSnapshot } from "./react-tool-agent";

const PLANNER_TOOLS = [
  "ls",
  "glob",
  "grep",
  "read"
];

export class PlannerAgent {
  constructor(
    private readonly client: ChatCompletionClient | null,
    private readonly model: string | null,
    private readonly workspaceRoot: string,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolContext: ToolExecutionContext
  ) {}

  async buildPlan(
    task: string,
    conversationContext = "",
    signal?: AbortSignal,
    hooks?: {
      onToolCallCompleted?: (call: ToolLoopToolCallSnapshot) => void;
    }
  ): Promise<{ plan: ExecutionPlan; toolCalls: ToolCallRecord[] }> {
    throwIfAborted(signal);
    if (!this.client || !this.model) {
      return { plan: fallbackPlan(task), toolCalls: [] };
    }

    const userPromptSections = [
      "User task:",
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
      "Explore the codebase using read-only tools to understand the relevant files and code structure, then produce a detailed execution plan as strict JSON."
    );
    const userPrompt = userPromptSections.join("\n");
    const projectContext = loadProjectContextFromWorkspace(this.workspaceRoot, this.toolContext.logger);
    const tokenBudget = buildInitialPromptTokenBudget(this.toolContext.modelTokenBudget);

    const agent = new ReactToolAgent(this.client, this.model, this.toolRegistry, this.toolContext);
    const maxTurns = this.toolContext.agentSettings?.toolLoop.searchMaxTurns ?? 12;
    const output = await agent.run({
      systemPrompt: plannerSystemPrompt({
        workspaceRoot: this.workspaceRoot,
        enabledTools: PLANNER_TOOLS,
        projectContext,
        tokenBudget
      }),
      userPrompt,
      allowedTools: PLANNER_TOOLS,
      maxTurns,
      temperature: 0.15,
      onToolCallCompleted: hooks?.onToolCallCompleted,
      signal
    });

    const toolCalls: ToolCallRecord[] = output.toolCalls.map((call) => ({
      toolName: call.name,
      args: call.args,
      result: call.result,
      timestamp: new Date().toISOString()
    }));

    const parsed = parseJsonObject(output.finalText);
    if (!parsed) {
      return { plan: fallbackPlan(task), toolCalls };
    }

    const title = typeof parsed.title === "string" ? parsed.title.trim() : undefined;
    const goal = typeof parsed.goal === "string" ? parsed.goal : task;
    const instruction = typeof parsed.instruction === "string" ? parsed.instruction.trim() : undefined;
    const suggestedTestCommand = typeof parsed.suggestedTestCommand === "string" ? parsed.suggestedTestCommand : undefined;
    const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
    const steps = rawSteps
      .map((step) => toStep(step))
      .filter((step): step is PlanStep => step !== null);

    if (steps.length === 0) {
      return { plan: fallbackPlan(task), toolCalls };
    }

    return {
      plan: {
        title,
        goal,
        steps,
        suggestedTestCommand,
        instruction
      },
      toolCalls
    };
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Interrupted by user");
  }
}

function toStep(value: unknown): PlanStep | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;

  const id = typeof record.id === "string" && record.id.trim() ? record.id : randomUUID().slice(0, 8);
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const owner = record.owner === "search" || record.owner === "code" ? record.owner : "code";
  const acceptance = typeof record.acceptance === "string" ? record.acceptance.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : undefined;
  const files = Array.isArray(record.files)
    ? record.files.filter((f): f is string => typeof f === "string" && f.trim().length > 0).map((f) => f.trim())
    : undefined;

  if (!title || !acceptance) {
    return null;
  }

  return { id, title, owner, acceptance, description, files };
}

function fallbackPlan(task: string): ExecutionPlan {
  return {
    title: "执行任务计划",
    goal: task,
    instruction: "请按照以下任务列表逐步完成所有任务，完成每个步骤后输出 [STEP_DONE:步骤ID] 标记。",
    steps: [
      {
        id: "S1",
        title: "定位与任务相关的文件和关键代码位置",
        owner: "search",
        acceptance: "产出一组可执行修改的文件路径列表。"
      },
      {
        id: "S2",
        title: "阅读关键代码并设计最小改动方案",
        owner: "code",
        acceptance: "形成低风险、可验证的修改策略。"
      },
      {
        id: "S3",
        title: "执行代码修改并保存",
        owner: "code",
        acceptance: "完成目标变更，且无明显语法问题。"
      },
      {
        id: "S4",
        title: "运行校验命令并总结结果",
        owner: "code",
        acceptance: "至少执行一次验证命令并反馈结果。"
      }
    ],
    suggestedTestCommand: "npm test"
  };
}
