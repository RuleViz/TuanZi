import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ToolExecutionResultSnapshot {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ToolLoopToolCallSnapshot {
  name: string;
  args: Record<string, unknown>;
  result: ToolExecutionResultSnapshot;
}

export interface ChatMessageSnapshot {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  thinking?: string;
}

export interface ToolLoopResumeStateSnapshot {
  version: 1;
  messages: ChatMessageSnapshot[];
  toolCalls: ToolLoopToolCallSnapshot[];
  allowedTools: string[];
  temperature: number;
  maxTurns: number;
  nextTurn: number;
  partialAssistantMessage: ChatMessageSnapshot | null;
}

export interface AppChatResumeSnapshot {
  version: 1;
  taskId: string;
  sessionId: string;
  workspace: string;
  message: string;
  history: Array<{ user: string; assistant: string }>;
  agentId: string | null;
  thinkingEnabled: boolean;
  streamedText: string;
  streamedThinking: string;
  toolCalls: ToolLoopToolCallSnapshot[];
  resumeState: ToolLoopResumeStateSnapshot | null;
  updatedAt: string;
}

export class ChatResumeStore {
  private readonly filePath: string;

  constructor(baseDir: string) {
    this.filePath = join(baseDir, "chat-runtime", "active-chat.json");
  }

  save(snapshot: AppChatResumeSnapshot): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(snapshot, null, 2), "utf8");
  }

  load(): AppChatResumeSnapshot | null {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return isAppChatResumeSnapshot(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  clear(): void {
    rmSync(this.filePath, { force: true });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isToolCallSnapshot(value: unknown): value is ToolLoopToolCallSnapshot {
  if (!isObject(value)) {
    return false;
  }
  return typeof value.name === "string" && isObject(value.args) && isObject(value.result);
}

function isResumeStateSnapshot(value: unknown): value is ToolLoopResumeStateSnapshot {
  if (!isObject(value)) {
    return false;
  }
  return (
    value.version === 1 &&
    Array.isArray(value.messages) &&
    Array.isArray(value.toolCalls) &&
    Array.isArray(value.allowedTools) &&
    typeof value.temperature === "number" &&
    typeof value.maxTurns === "number" &&
    typeof value.nextTurn === "number" &&
    (value.partialAssistantMessage === null || isObject(value.partialAssistantMessage))
  );
}

function isAppChatResumeSnapshot(value: unknown): value is AppChatResumeSnapshot {
  if (!isObject(value)) {
    return false;
  }
  return (
    value.version === 1 &&
    typeof value.taskId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.workspace === "string" &&
    typeof value.message === "string" &&
    Array.isArray(value.history) &&
    (value.agentId === null || typeof value.agentId === "string") &&
    typeof value.thinkingEnabled === "boolean" &&
    typeof value.streamedText === "string" &&
    typeof value.streamedThinking === "string" &&
    Array.isArray(value.toolCalls) &&
    value.toolCalls.every((item) => isToolCallSnapshot(item)) &&
    (value.resumeState === null || isResumeStateSnapshot(value.resumeState)) &&
    typeof value.updatedAt === "string"
  );
}
