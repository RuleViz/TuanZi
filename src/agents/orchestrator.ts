import { randomUUID } from "node:crypto";
import type {
  ExecutionPlan,
  RoutingSettings,
  ToolCallRecord,
  ToolExecutionContext
} from "../core/types";
import type {
  ToolLoopResumeAnchor,
  ToolLoopResumeState,
  ToolLoopToolCallSnapshot
} from "./react-tool-agent";
import type { ChatInputImage } from "./model-types";
import { PlannerAgent } from "./planner-agent";
import { SearcherAgent } from "./searcher-agent";
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

interface PlanResumeTarget {
  stepId: string;
  stepIndex: number;
}

export class PlanToDoOrchestrator {
  constructor(
    private readonly coder: TuanZiAgent,
    private readonly planner: PlannerAgent,
    private readonly searcher: SearcherAgent,
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
    const plan = await this.planner.buildPlan(task, conversationContext, hooks?.signal);
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
        toolCalls: []
      };
    }

    throwIfAborted(hooks?.signal);
    hooks?.onPhaseChange?.("running");
    hooks?.onTasksChange?.(
      inputPlanToTaskSnapshots(plan, {
        activeStepId: null,
        completedStepIds: new Set(),
        failedStepId: null
      })
    );
    const output = await this.executePlanSteps({
      task,
      plan,
      conversationContext,
      resumeState,
      userImages,
      hooks
    });
    hooks?.onPhaseChange?.("done");
    return output;
  }

  private async executePlanSteps(input: {
    task: string;
    plan: ExecutionPlan;
    conversationContext: string;
    resumeState?: ToolLoopResumeState;
    userImages?: ChatInputImage[];
    hooks?: OrchestratorRunHooks;
    }): Promise<OrchestrationResult> {
    const allToolCalls: ToolCallRecord[] = [];
    const changedFiles = new Set<string>();
    const executedCommands = new Map<string, { command: string; exitCode: number | null }>();
    const followUp = new Set<string>();
    const stepSummaries: string[] = [];
    let searchContext = "";
    let lastCodeSummary = "";
    const resumeTarget = resolvePlanResumeTarget(input.resumeState, input.plan);
    const shouldResumeAnchorStep = shouldResumeFromAnchorStep(input.resumeState);
    const firstCodeStepIndexToExecute =
      resumeTarget && !shouldResumeAnchorStep ? resumeTarget.stepIndex + 1 : resumeTarget?.stepIndex ?? 0;
    let resumeStateConsumed = false;
    const completedStepIds = new Set<string>();

    if (input.resumeState && !resumeTarget) {
      followUp.add("Resume state was ignored because no matching plan step anchor was found.");
    } else if (input.resumeState && resumeTarget && !shouldResumeAnchorStep) {
      followUp.add("Resume anchor step was already completed; execution continued from the next step.");
    }

    for (let stepIndex = 0; stepIndex < input.plan.steps.length; stepIndex += 1) {
      throwIfAborted(input.hooks?.signal);
      const step = input.plan.steps[stepIndex];
      input.hooks?.onTasksChange?.(
        inputPlanToTaskSnapshots(input.plan, {
          activeStepId: step.id,
          completedStepIds,
          failedStepId: null
        })
      );

      try {
        if (step.owner === "search") {
          const searchTask = buildSearchTask(input.task, step.title, step.acceptance);
          const searchOutput = await this.searcher.search(
            searchTask,
            input.plan,
            input.conversationContext,
            input.hooks?.signal,
            {
              onToolCallCompleted: input.hooks?.onToolCallCompleted
            }
          );
          allToolCalls.push(...searchOutput.toolCalls);
          const refs = searchOutput.result.references.slice(0, 8).map((reference) => reference.path);
          searchContext = buildSearchContext(searchOutput.result.summary, refs);
          stepSummaries.push(`- ${step.id} ${step.title}: search completed, matched ${searchOutput.result.references.length} candidate files.`);
          completedStepIds.add(step.id);
          input.hooks?.onTasksChange?.(
            inputPlanToTaskSnapshots(input.plan, {
              activeStepId: null,
              completedStepIds,
              failedStepId: null
            })
          );
          continue;
        }

        if (resumeTarget && stepIndex < firstCodeStepIndexToExecute) {
          const reason =
            stepIndex < resumeTarget.stepIndex
              ? "skipped (already completed before resume target)."
              : "skipped (resume anchor step was already completed).";
          stepSummaries.push(`- ${step.id} ${step.title}: ${reason}`);
          completedStepIds.add(step.id);
          input.hooks?.onTasksChange?.(
            inputPlanToTaskSnapshots(input.plan, {
              activeStepId: null,
              completedStepIds,
              failedStepId: null
            })
          );
          continue;
        }

        const shouldResumeThisStep: boolean = Boolean(
          input.resumeState &&
          resumeTarget &&
          shouldResumeAnchorStep &&
          !resumeStateConsumed &&
          stepIndex === resumeTarget.stepIndex
        );
        const codeTask = buildCodeTask(input.task, input.plan, step.id, step.title, step.acceptance, searchContext);
        const coderOutput = await this.coder.execute(codeTask, input.conversationContext, {
          onAssistantTextDelta: input.hooks?.onAssistantTextDelta,
          onAssistantThinkingDelta: input.hooks?.onAssistantThinkingDelta,
          onToolCallCompleted: input.hooks?.onToolCallCompleted,
          onStateChange: (state) => {
            input.hooks?.onStateChange?.(applyPlanResumeAnchor(state, step.id, stepIndex));
          },
          resumeState: shouldResumeThisStep ? input.resumeState : undefined,
          userImages: input.userImages,
          signal: input.hooks?.signal
        });
        resumeStateConsumed = resumeStateConsumed || shouldResumeThisStep;
        lastCodeSummary = coderOutput.result.summary;
        allToolCalls.push(...coderOutput.toolCalls);
        for (const file of coderOutput.result.changedFiles) {
          changedFiles.add(file);
        }
        for (const command of coderOutput.result.executedCommands) {
          executedCommands.set(`${command.command}::${String(command.exitCode)}`, command);
        }
        for (const note of coderOutput.result.followUp) {
          followUp.add(note);
        }
        stepSummaries.push(
          shouldResumeThisStep
            ? `- ${step.id} ${step.title}: resumed from saved state and completed.`
            : `- ${step.id} ${step.title}: code execution completed.`
        );
        completedStepIds.add(step.id);
        input.hooks?.onTasksChange?.(
          inputPlanToTaskSnapshots(input.plan, {
            activeStepId: null,
            completedStepIds,
            failedStepId: null
          })
        );
      } catch (error) {
        input.hooks?.onTasksChange?.(
          inputPlanToTaskSnapshots(input.plan, {
            activeStepId: null,
            completedStepIds,
            failedStepId: step.id
          })
        );
        throw error;
      }
    }

    return {
      summary: [
        "Executed in plan mode.",
        `Plan goal: ${input.plan.goal}`,
        `Step count: ${input.plan.steps.length}`,
        "Step results:",
        ...stepSummaries,
        "",
        lastCodeSummary || "Plan steps completed."
      ].join("\n"),
      changedFiles: [...changedFiles],
      executedCommands: [...executedCommands.values()],
      followUp: [...followUp],
      toolCalls: allToolCalls
    };
  }
}

function shouldResumeFromAnchorStep(resumeState: ToolLoopResumeState | undefined): boolean {
  const partial = resumeState?.partialAssistantMessage;
  if (!partial) {
    return false;
  }
  const hasTextContent =
    (typeof partial.content === "string" && partial.content.trim().length > 0) ||
    (Array.isArray(partial.content) &&
      partial.content.some((part) => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0));
  const hasThinkingContent = typeof partial.reasoning_content === "string" && partial.reasoning_content.trim().length > 0;
  const hasToolCalls = Array.isArray(partial.tool_calls) && partial.tool_calls.length > 0;
  return hasTextContent || hasThinkingContent || hasToolCalls;
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

function inputPlanToTaskSnapshots(
  plan: ExecutionPlan,
  input: {
    activeStepId: string | null;
    completedStepIds: Set<string>;
    failedStepId: string | null;
  }
): OrchestratorTaskSnapshot[] {
  return plan.steps.map((step) => {
    let status: OrchestratorTaskSnapshot["status"] = "pending";
    if (input.failedStepId === step.id) {
      status = "failed";
    } else if (input.activeStepId === step.id) {
      status = "running";
    } else if (input.completedStepIds.has(step.id)) {
      status = "done";
    }

    return {
      id: step.id,
      title: step.title,
      kind: step.owner === "search" ? "search" : "coding",
      status,
      detail: step.acceptance
    };
  });
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
  const lines = [`Goal: ${plan.goal}`, "Steps:"];
  for (const step of plan.steps) {
    lines.push(`- [${step.id}] (${step.owner}) ${step.title}`);
    lines.push(`  Acceptance: ${step.acceptance}`);
  }
  if (plan.suggestedTestCommand) {
    lines.push(`Suggested test command: ${plan.suggestedTestCommand}`);
  }
  return lines.join("\n");
}

function buildSearchTask(task: string, title: string, acceptance: string): string {
  return [task, "", `Current step (search): ${title}`, `Acceptance criteria: ${acceptance}`].join("\n");
}

function buildSearchContext(summary: string, references: string[]): string {
  if (references.length === 0) {
    return `Search summary: ${summary}`;
  }
  return [`Search summary: ${summary}`, "Candidate files:", ...references.map((path) => `- ${path}`)].join("\n");
}

function buildCodeTask(
  task: string,
  plan: ExecutionPlan,
  stepId: string,
  title: string,
  acceptance: string,
  searchContext: string
): string {
  const sections = [
    "You are executing one step from an approved plan.",
    `Original task: ${task}`,
    `Plan goal: ${plan.goal}`,
    `Current step id: ${stepId}`,
    `Current step: ${title}`,
    `Acceptance criteria: ${acceptance}`
  ];
  if (searchContext) {
    sections.push("", "Searcher findings:", searchContext);
  }
  if (plan.suggestedTestCommand) {
    sections.push("", `Suggested validation command: ${plan.suggestedTestCommand}`);
  }
  return sections.join("\n");
}

function applyPlanResumeAnchor(
  state: ToolLoopResumeState,
  stepId: string,
  stepIndex: number
): ToolLoopResumeState {
  const resumeAnchor: ToolLoopResumeAnchor = {
    mode: "plan",
    stepId,
    stepIndex
  };
  return {
    ...state,
    resumeAnchor
  };
}

function resolvePlanResumeTarget(
  resumeState: ToolLoopResumeState | undefined,
  plan: ExecutionPlan
): PlanResumeTarget | null {
  const anchor = resumeState?.resumeAnchor;
  if (!anchor || anchor.mode !== "plan") {
    return null;
  }
  if (!anchor.stepId || !Number.isInteger(anchor.stepIndex) || anchor.stepIndex < 0) {
    return null;
  }

  const byIndex = plan.steps[anchor.stepIndex];
  if (byIndex && byIndex.owner === "code" && byIndex.id === anchor.stepId) {
    return {
      stepId: anchor.stepId,
      stepIndex: anchor.stepIndex
    };
  }

  const byIdIndex = plan.steps.findIndex((step) => step.owner === "code" && step.id === anchor.stepId);
  if (byIdIndex < 0) {
    return null;
  }
  return {
    stepId: anchor.stepId,
    stepIndex: byIdIndex
  };
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
          const rawResult = JSON.stringify(call.result);
          resultStr = rawResult.length > 1500 ? rawResult.slice(0, 1500) + "...(truncated)" : rawResult;
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
