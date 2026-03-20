import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ToolExecutionResultSnapshot {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ToolLoopToolCallSnapshot {
  id?: string;
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

export interface ToolLoopResumeAnchorSnapshot {
  mode: "plan";
  stepId: string;
  stepIndex: number;
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
  resumeAnchor?: ToolLoopResumeAnchorSnapshot;
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
  checkpointId?: string | null;
  updatedAt: string;
}

export class ChatResumeStore {
  private readonly filePath: string;

  constructor(baseDir: string) {
    this.filePath = join(baseDir, "chat-runtime", "active-chat.json");
  }

  async save(snapshot: AppChatResumeSnapshot): Promise<number> {
    const serialized = JSON.stringify(snapshot);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, serialized, "utf8");
    return Buffer.byteLength(serialized, "utf8");
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

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isToolCallSnapshot(value: unknown): value is ToolLoopToolCallSnapshot {
  if (!isObject(value)) {
    return false;
  }
  return (
    (value.id === undefined || typeof value.id === "string") &&
    typeof value.name === "string" &&
    isObject(value.args) &&
    isObject(value.result)
  );
}

function isResumeAnchorSnapshot(value: unknown): value is ToolLoopResumeAnchorSnapshot {
  if (!isObject(value)) {
    return false;
  }
  return (
    value.mode === "plan" &&
    typeof value.stepId === "string" &&
    value.stepId.length > 0 &&
    typeof value.stepIndex === "number" &&
    Number.isInteger(value.stepIndex) &&
    value.stepIndex >= 0
  );
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
    (value.partialAssistantMessage === null || isObject(value.partialAssistantMessage)) &&
    (value.resumeAnchor === undefined || isResumeAnchorSnapshot(value.resumeAnchor))
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
    (value.checkpointId === undefined || value.checkpointId === null || typeof value.checkpointId === "string") &&
    typeof value.updatedAt === "string"
  );
}
