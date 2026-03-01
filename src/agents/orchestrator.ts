import { randomUUID } from "node:crypto";
import type { ToolCallRecord, ToolExecutionContext } from "../core/types";
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
}

export interface OrchestratorRunInput {
  task: string;
  memoryTurns?: ConversationMemoryTurn[];
}

export class PlanToDoOrchestrator {
  constructor(
    private readonly coder: TuanZiAgent,
    private readonly toolContext: ToolExecutionContext
  ) { }

  async run(input: string | OrchestratorRunInput): Promise<OrchestrationResult> {
    const { task, memoryTurns } = normalizeRunInput(input);
    const conversationContext = buildConversationContext(memoryTurns);
    this.toolContext.taskId = randomUUID();
    const coderOutput = await this.coder.execute(task, conversationContext);
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
    memoryTurns: input.memoryTurns
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
    chunks.push(turnTextParts.join("\n"));
  }

  const context = chunks.join("\n\n");
  if (maxChars !== null && context.length > maxChars) {
    return context.slice(context.length - maxChars);
  }
  return context;
}
