import { randomUUID } from "node:crypto";
import type { ToolCallRecord, ToolExecutionContext } from "../core/types";
import type { ToolLoopResumeState, ToolLoopToolCallSnapshot } from "./react-tool-agent";
import type { ChatInputImage } from "./model-types";
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
}

export type OrchestratorPhase = "running";

export interface OrchestratorRunHooks {
  onPhaseChange?: (phase: OrchestratorPhase) => void;
  onAssistantTextDelta?: (delta: string) => void;
  onAssistantThinkingDelta?: (delta: string) => void;
  onToolCallCompleted?: (call: ToolLoopToolCallSnapshot) => void;
  onStateChange?: (state: ToolLoopResumeState) => void;
  signal?: AbortSignal;
}

export class PlanToDoOrchestrator {
  constructor(
    private readonly coder: TuanZiAgent,
    private readonly toolContext: ToolExecutionContext
  ) { }

  async run(input: string | OrchestratorRunInput, hooks?: OrchestratorRunHooks): Promise<OrchestrationResult> {
    const { task, memoryTurns, conversationContext: explicitConversationContext, resumeState, userImages } =
      normalizeRunInput(input);
    const conversationContext = explicitConversationContext ?? buildConversationContext(memoryTurns);
    this.toolContext.taskId = randomUUID();
    hooks?.onPhaseChange?.("running");
    this.toolContext.signal = hooks?.signal;
    const coderOutput = await this.coder.execute(task, conversationContext, {
      onAssistantTextDelta: hooks?.onAssistantTextDelta,
      onAssistantThinkingDelta: hooks?.onAssistantThinkingDelta,
      onToolCallCompleted: hooks?.onToolCallCompleted,
      onStateChange: hooks?.onStateChange,
      resumeState,
      userImages,
      signal: hooks?.signal
    });

    return {
      summary: coderOutput.result.summary,
      changedFiles: coderOutput.result.changedFiles,
      executedCommands: coderOutput.result.executedCommands,
      followUp: coderOutput.result.followUp,
      toolCalls: coderOutput.toolCalls
    };
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
    userImages: input.userImages
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
