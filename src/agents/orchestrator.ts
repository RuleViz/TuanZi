import { randomUUID } from "node:crypto";
import type {
  ExecutionPlan,
  RoutingSettings,
  ToolCallRecord,
  ToolExecutionContext
} from "../core/types";
import type {
  ToolLoopResumeState,
  ToolLoopToolCallSnapshot
} from "./react-tool-agent";
import type { ChatInputImage } from "./model-types";
import { PlannerAgent } from "./planner-agent";
import { TuanZiAgent } from "./tuanzi";

export interface OrchestrationResult {
  summary: string;
  changedFiles: string[];
  executedCommands: Array<{ command: string; exitCode: number | null }>;
  followUp: string[];
  toolCalls: ToolCallRecord[];
}

export interface ConversationMemoryTurn {
  user: string;
  assistant: string;
  toolCalls?: ToolCallRecord[];
}

export interface OrchestratorRunInput {
  task: string;
  memoryTurns?: ConversationMemoryTurn[];
  conversationContext?: string;
  resumeState?: ToolLoopResumeState;
  userImages?: ChatInputImage[];
  forcePlanMode?: boolean;
}

export type OrchestratorPhase = "planning" | "approval" | "running" | "done" | "aborted";

export interface OrchestratorTaskSnapshot {
  id: string;
  title: string;
  kind: "plan" | "execution" | "search" | "coding";
  status: "pending" | "running" | "done" | "failed";
  detail?: string;
  parentGroupId?: string;
}

export interface OrchestratorRunHooks {
  onPhaseChange?: (phase: OrchestratorPhase) => void;
  onPlanPreview?: (preview: string) => void;
  onTasksChange?: (tasks: OrchestratorTaskSnapshot[]) => void;
  onAssistantTextDelta?: (delta: string) => void;
  onAssistantThinkingDelta?: (delta: string) => void;
  onToolCallCompleted?: (call: ToolLoopToolCallSnapshot) => void;
  onStateChange?: (state: ToolLoopResumeState) => void;
  signal?: AbortSignal;
}

export class PlanToDoOrchestrator {
  constructor(
    private readonly coder: TuanZiAgent,
    private readonly planner: PlannerAgent,
    private readonly toolContext: ToolExecutionContext
  ) {}

  async run(input: string | OrchestratorRunInput, hooks?: OrchestratorRunHooks): Promise<OrchestrationResult> {
    const {
      task,
      memoryTurns,
      conversationContext: explicitConversationContext,
      resumeState,
      userImages,
      forcePlanMode
    } = normalizeRunInput(input);
    const conversationContext = explicitConversationContext ?? buildConversationContext(memoryTurns);
    this.toolContext.taskId = randomUUID();
    this.toolContext.signal = hooks?.signal;

    const usePlanMode = forcePlanMode === true ? true : shouldUsePlanMode(task, this.toolContext.agentSettings?.routing);
    if (!usePlanMode) {
      hooks?.onTasksChange?.([
        {
          id: "direct-execution",
          title: "Execute current request",
          kind: "execution",
          status: "running",
          detail: "Agent is working directly without plan mode."
        }
      ]);
      hooks?.onPhaseChange?.("running");
      try {
        const coderOutput = await this.coder.execute(task, conversationContext, {
          onAssistantTextDelta: hooks?.onAssistantTextDelta,
          onAssistantThinkingDelta: hooks?.onAssistantThinkingDelta,
          onToolCallCompleted: hooks?.onToolCallCompleted,
          onStateChange: hooks?.onStateChange,
          resumeState,
          userImages,
          signal: hooks?.signal
        });
        hooks?.onTasksChange?.([
          {
            id: "direct-execution",
            title: "Execute current request",
            kind: "execution",
            status: "done",
            detail: "Direct execution completed."
          }
        ]);
        hooks?.onPhaseChange?.("done");

        return {
          summary: coderOutput.result.summary,
          changedFiles: coderOutput.result.changedFiles,
          executedCommands: coderOutput.result.executedCommands,
          followUp: coderOutput.result.followUp,
          toolCalls: coderOutput.toolCalls
        };
      } catch (error) {
        hooks?.onTasksChange?.([
          {
            id: "direct-execution",
            title: "Execute current request",
            kind: "execution",
            status: "failed",
            detail: error instanceof Error ? error.message : String(error)
          }
        ]);
        throw error;
      }
    }

    throwIfAborted(hooks?.signal);
    hooks?.onPhaseChange?.("planning");
    const planResult = await this.planner.buildPlan(task, conversationContext, hooks?.signal, {
      onToolCallCompleted: hooks?.onToolCallCompleted
    });
    const plan = planResult.plan;
    throwIfAborted(hooks?.signal);
    hooks?.onPlanPreview?.(formatPlanPreview(plan));

    throwIfAborted(hooks?.signal);
    hooks?.onPhaseChange?.("approval");
    const approval = await this.toolContext.approvalGate.approve({
      requestType: "plan",
      action: "Execute generated plan",
      risk: "medium",
      preview: formatPlanPreview(plan)
    });
    if (!approval.approved) {
      hooks?.onPhaseChange?.("aborted");
      const reason = approval.reason ? `Reason: ${approval.reason}` : "Reason: user rejected the plan.";
      return {
        summary: ["Plan mode is enabled, but the plan was not approved.", reason].join("\n"),
        changedFiles: [],
        executedCommands: [],
        followUp: ["I can adjust the plan and retry when you're ready."],
        toolCalls: planResult.toolCalls
      };
    }

    throwIfAborted(hooks?.signal);
    hooks?.onPhaseChange?.("running");
    const planGroupId = `plan-group-${this.toolContext.taskId ?? randomUUID()}`;
    hooks?.onTasksChange?.(
      planToTaskGroup(plan, {
        groupId: planGroupId,
        completedStepIds: new Set(),
        failedStepId: null,
        allRunning: true
      })
    );
    const output = await this.executePlanOneShot({
      task,
      plan,
      planGroupId,
      plannerToolCalls: planResult.toolCalls,
      resumeState,
      userImages,
      hooks
    });
    hooks?.onPhaseChange?.("done");
    return output;
  }

  private async executePlanOneShot(input: {
    task: string;
    plan: ExecutionPlan;
    planGroupId: string;
    plannerToolCalls: ToolCallRecord[];
    resumeState?: ToolLoopResumeState;
    userImages?: ChatInputImage[];
    hooks?: OrchestratorRunHooks;
  }): Promise<OrchestrationResult> {
    const completedStepIds = new Set<string>();
    const stepIds = new Set(input.plan.steps.map((s) => s.id));
    let pendingDeltaBuffer = "";

    const emitTaskGroup = (): void => {
      input.hooks?.onTasksChange?.(
        planToTaskGroup(input.plan, {
          groupId: input.planGroupId,
          completedStepIds,
          failedStepId: null,
          allRunning: true
        })
      );
    };

    const onTextDelta = (delta: string): void => {
      input.hooks?.onAssistantTextDelta?.(delta);
      pendingDeltaBuffer += delta;
      const extracted = extractStepDoneMarkers(pendingDeltaBuffer, stepIds);
      if (extracted.found.length > 0) {
        for (const id of extracted.found) {
          completedStepIds.add(id);
        }
        pendingDeltaBuffer = extracted.remaining;
        emitTaskGroup();
      }
      if (pendingDeltaBuffer.length > 200) {
        pendingDeltaBuffer = pendingDeltaBuffer.slice(-100);
      }
    };

    const planTaskMessage = buildOneShotPlanTask(input.task, input.plan);

    try {
      const coderOutput = await this.coder.execute(planTaskMessage, "", {
        onAssistantTextDelta: onTextDelta,
        onAssistantThinkingDelta: input.hooks?.onAssistantThinkingDelta,
        onToolCallCompleted: input.hooks?.onToolCallCompleted,
        onStateChange: input.hooks?.onStateChange,
        resumeState: input.resumeState,
        userImages: input.userImages,
        signal: input.hooks?.signal
      });

      for (const step of input.plan.steps) {
        completedStepIds.add(step.id);
      }
      input.hooks?.onTasksChange?.(
        planToTaskGroup(input.plan, {
          groupId: input.planGroupId,
          completedStepIds,
          failedStepId: null,
          allRunning: false
        })
      );

      return {
        summary: [
          "Executed in plan mode (one-shot).",
          `Plan: ${input.plan.title || input.plan.goal}`,
          `Step count: ${input.plan.steps.length}`,
          "",
          coderOutput.result.summary || "Plan steps completed."
        ].join("\n"),
        changedFiles: coderOutput.result.changedFiles,
        executedCommands: coderOutput.result.executedCommands,
        followUp: coderOutput.result.followUp,
        toolCalls: [...input.plannerToolCalls, ...coderOutput.toolCalls]
      };
    } catch (error) {
      input.hooks?.onTasksChange?.(
        planToTaskGroup(input.plan, {
          groupId: input.planGroupId,
          completedStepIds,
          failedStepId: findFirstIncompleteStepId(input.plan, completedStepIds),
          allRunning: false
        })
      );
      throw error;
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Interrupted by user");
  }
}

function normalizeRunInput(input: string | OrchestratorRunInput): OrchestratorRunInput {
  if (typeof input === "string") {
    return { task: input };
  }
  return {
    task: input.task,
    memoryTurns: input.memoryTurns,
    conversationContext: input.conversationContext,
    resumeState: input.resumeState,
    userImages: input.userImages,
    forcePlanMode: input.forcePlanMode
  };
}

function planToTaskGroup(
  plan: ExecutionPlan,
  input: {
    groupId: string;
    completedStepIds: Set<string>;
    failedStepId: string | null;
    allRunning: boolean;
  }
): OrchestratorTaskSnapshot[] {
  const groupTitle = plan.title || plan.goal;
  const allDone = !input.allRunning && plan.steps.every((s) => input.completedStepIds.has(s.id));
  const hasFailed = input.failedStepId !== null;
  const groupStatus: OrchestratorTaskSnapshot["status"] = hasFailed
    ? "failed"
    : allDone
      ? "done"
      : input.allRunning
        ? "running"
        : "pending";

  const groupItem: OrchestratorTaskSnapshot = {
    id: input.groupId,
    title: groupTitle,
    kind: "plan",
    status: groupStatus,
    detail: plan.goal
  };

  const stepItems: OrchestratorTaskSnapshot[] = plan.steps.map((step) => {
    let status: OrchestratorTaskSnapshot["status"] = input.allRunning ? "running" : "pending";
    if (input.failedStepId === step.id) {
      status = "failed";
    } else if (input.completedStepIds.has(step.id)) {
      status = "done";
    }

    const detailParts: string[] = [];
    if (step.description) {
      detailParts.push(step.description);
    }
    if (step.files && step.files.length > 0) {
      detailParts.push(`涉及文件: ${step.files.join(", ")}`);
    }
    if (step.acceptance) {
      detailParts.push(`验收: ${step.acceptance}`);
    }

    return {
      id: step.id,
      title: step.title,
      kind: step.owner === "search" ? ("search" as const) : ("coding" as const),
      status,
      detail: detailParts.join("\n") || step.acceptance,
      parentGroupId: groupItem.id
    };
  });

  return [groupItem, ...stepItems];
}

export function shouldUsePlanMode(task: string, routing?: RoutingSettings): boolean {
  if (!routing) {
    return false;
  }

  const normalizedTask = task.toLowerCase();
  if (hasPlanIntent(normalizedTask)) {
    return true;
  }

  if (!routing.enableDirectMode) {
    return true;
  }

  const directPatternMatched = routing.directIntentPatterns.some((pattern) => {
    const normalizedPattern = pattern.trim().toLowerCase();
    return normalizedPattern.length > 0 && normalizedTask.includes(normalizedPattern);
  });

  if (routing.defaultEnablePlanMode && !directPatternMatched) {
    return true;
  }

  return false;
}

function hasPlanIntent(taskLowerText: string): boolean {
  const intents = ["plan mode", "先计划", "先分析", "按计划", "step by step", "先出方案"];
  return intents.some((intent) => taskLowerText.includes(intent));
}

function formatPlanPreview(plan: ExecutionPlan): string {
  const lines: string[] = [];
  if (plan.title) {
    lines.push(`Title: ${plan.title}`);
  }
  lines.push(`Goal: ${plan.goal}`, "Steps:");
  for (const step of plan.steps) {
    lines.push(`- [${step.id}] (${step.owner}) ${step.title}`);
    if (step.description) {
      lines.push(`  Description: ${step.description}`);
    }
    if (step.files && step.files.length > 0) {
      lines.push(`  Files: ${step.files.join(", ")}`);
    }
    lines.push(`  Acceptance: ${step.acceptance}`);
  }
  if (plan.suggestedTestCommand) {
    lines.push(`Suggested test command: ${plan.suggestedTestCommand}`);
  }
  return lines.join("\n");
}

function buildOneShotPlanTask(task: string, plan: ExecutionPlan): string {
  const sections: string[] = [];

  if (plan.instruction) {
    sections.push(plan.instruction);
    sections.push("");
  } else {
    sections.push("请按照以下任务列表逐步完成所有任务，完成每个步骤后输出 [STEP_DONE:步骤ID] 标记。");
    sections.push("");
  }

  sections.push(`原始需求: ${task}`);
  if (plan.title) {
    sections.push(`任务主题: ${plan.title}`);
  }
  sections.push(`目标: ${plan.goal}`);
  sections.push("");
  sections.push("=== 任务列表 ===");

  for (const step of plan.steps) {
    sections.push("");
    sections.push(`[${step.id}] ${step.title}`);
    if (step.description) {
      sections.push(`  描述: ${step.description}`);
    }
    if (step.files && step.files.length > 0) {
      sections.push(`  涉及文件: ${step.files.join(", ")}`);
    }
    sections.push(`  验收标准: ${step.acceptance}`);
  }

  if (plan.suggestedTestCommand) {
    sections.push("");
    sections.push(`建议验证命令: ${plan.suggestedTestCommand}`);
  }

  sections.push("");
  sections.push("请严格按照上述任务列表顺序执行，完成每个步骤后输出 [STEP_DONE:步骤ID] 标记（例如 [STEP_DONE:S1]）。");

  return sections.join("\n");
}

function extractStepDoneMarkers(
  buffer: string,
  validStepIds: Set<string>
): { found: string[]; remaining: string } {
  const pattern = /\[STEP_DONE:(\w+)\]/g;
  const found: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(buffer)) !== null) {
    const stepId = match[1];
    if (validStepIds.has(stepId)) {
      found.push(stepId);
    }
    lastIndex = match.index + match[0].length;
  }

  const remaining = lastIndex > 0 ? buffer.slice(lastIndex) : buffer;
  return { found, remaining };
}

function findFirstIncompleteStepId(plan: ExecutionPlan, completedStepIds: Set<string>): string | null {
  for (const step of plan.steps) {
    if (!completedStepIds.has(step.id)) {
      return step.id;
    }
  }
  return null;
}

export function buildConversationContext(
  memoryTurns: ConversationMemoryTurn[] | undefined,
  options?: { maxTurns?: number; maxChars?: number }
): string {
  if (!memoryTurns || memoryTurns.length === 0) {
    return "";
  }

  const maxTurns =
    typeof options?.maxTurns === "number" && Number.isFinite(options.maxTurns) && options.maxTurns > 0
      ? Math.floor(options.maxTurns)
      : null;
  const maxChars =
    typeof options?.maxChars === "number" && Number.isFinite(options.maxChars) && options.maxChars > 0
      ? Math.floor(options.maxChars)
      : null;
  const selectedTurns = maxTurns === null ? memoryTurns : memoryTurns.slice(-maxTurns);
  const chunks: string[] = [];

  for (let index = 0; index < selectedTurns.length; index += 1) {
    const turn = selectedTurns[index];
    const user = turn.user;
    const assistant = turn.assistant;
    if (!user && !assistant) {
      continue;
    }

    const turnTextParts = [`Turn ${index + 1}:`];
    if (user) {
      turnTextParts.push("User:");
      turnTextParts.push(user);
    }
    if (assistant) {
      turnTextParts.push("Assistant:");
      turnTextParts.push(assistant);
    }
    if (turn.toolCalls && turn.toolCalls.length > 0) {
      turnTextParts.push("Executed Tools:");
      for (const call of turn.toolCalls) {
        let resultStr = "";
        try {
          resultStr = JSON.stringify(call.result);
        } catch {
          resultStr = "[Unserializable result]";
        }
        turnTextParts.push(`- Tool: ${call.toolName} | Args: ${JSON.stringify(call.args)} | Result: ${resultStr}`);
      }
    }
    chunks.push(turnTextParts.join("\n"));
  }

  const context = chunks.join("\n\n");
  if (maxChars !== null && context.length > maxChars) {
    return context.slice(context.length - maxChars);
  }
  return context;
}
