import type {
  AppChatResumeSnapshot,
  ToolLoopResumeStateSnapshot,
  ToolLoopToolCallSnapshot
} from "../chat-resume-store.js";

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function buildPersistedResumeSnapshot(input: {
  taskId: string;
  sessionId: string;
  workspace: string;
  message: string;
  agentId: string | null;
  thinkingEnabled: boolean;
  streamedText: string;
  streamedThinking: string;
  toolCalls: ToolLoopToolCallSnapshot[];
  resumeState: ToolLoopResumeStateSnapshot | null;
}): AppChatResumeSnapshot {
  return {
    version: 1,
    taskId: input.taskId,
    sessionId: input.sessionId,
    workspace: input.workspace,
    message: input.message,
    history: [],
    agentId: input.agentId,
    thinkingEnabled: input.thinkingEnabled,
    streamedText: input.streamedText,
    streamedThinking: input.streamedThinking,
    toolCalls: cloneJson(input.toolCalls),
    resumeState: cloneJson(input.resumeState),
    updatedAt: new Date().toISOString()
  };
}
