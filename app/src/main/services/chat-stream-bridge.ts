import { IPC_CHANNELS } from "../../shared/ipc-channels";
import type { ToolLoopResumeStateSnapshot, ToolLoopToolCallSnapshot } from "../chat-resume-store";

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneToolCallSnapshot(call: ToolLoopToolCallSnapshot): ToolLoopToolCallSnapshot {
  return cloneJson(call);
}

export function cloneToolCallSnapshots(calls: ToolLoopToolCallSnapshot[]): ToolLoopToolCallSnapshot[] {
  return calls.map((call) => cloneToolCallSnapshot(call));
}

export function cloneResumeState(
  resumeState: ToolLoopResumeStateSnapshot | null
): ToolLoopResumeStateSnapshot | null {
  return resumeState ? cloneJson(resumeState) : null;
}

export function toRendererToolCall(call: ToolLoopToolCallSnapshot): {
  toolName: string;
  args: Record<string, unknown>;
  result: { ok: boolean; data?: unknown; error?: string };
  timestamp: string;
} {
  return {
    toolName: call.name,
    args: cloneJson(call.args),
    result: cloneJson(call.result),
    timestamp: new Date().toISOString()
  };
}

export function createChatStreamHooks(input: {
  webContents: Electron.WebContents;
  taskId: string;
  onAssistantTextDelta: (delta: string) => void;
  onAssistantThinkingDelta: (delta: string) => void;
  onToolCallCompleted: (call: ToolLoopToolCallSnapshot) => void;
  onStateChange: (state: ToolLoopResumeStateSnapshot) => void;
}): {
  onPhaseChange: (phase: string) => void;
  onAssistantTextDelta: (delta: string) => void;
  onAssistantThinkingDelta: (delta: string) => void;
  onToolCallCompleted: (call: ToolLoopToolCallSnapshot) => void;
  onStateChange: (state: ToolLoopResumeStateSnapshot) => void;
} {
  return {
    onPhaseChange: (phase: string) => {
      input.webContents.send(IPC_CHANNELS.chatPhase, { taskId: input.taskId, phase });
    },
    onAssistantTextDelta: (delta: string) => {
      if (!delta) {
        return;
      }
      input.onAssistantTextDelta(delta);
      input.webContents.send(IPC_CHANNELS.chatDelta, { taskId: input.taskId, delta });
    },
    onAssistantThinkingDelta: (delta: string) => {
      if (!delta) {
        return;
      }
      input.onAssistantThinkingDelta(delta);
      input.webContents.send(IPC_CHANNELS.chatThinking, { taskId: input.taskId, delta });
    },
    onToolCallCompleted: (call: ToolLoopToolCallSnapshot) => {
      input.onToolCallCompleted(call);
      input.webContents.send(IPC_CHANNELS.chatToolCallCompleted, {
        taskId: input.taskId,
        toolCall: toRendererToolCall(call)
      });
    },
    onStateChange: (state: ToolLoopResumeStateSnapshot) => {
      input.onStateChange(state);
    }
  };
}
