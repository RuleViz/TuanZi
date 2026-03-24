import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import type { GetResumeStatePayload, SendMessagePayload, StopMessagePayload } from "../../shared/ipc-contracts";
import type { ToolLoopResumeStateSnapshot } from "../chat-resume-store";
import type { ActiveTaskEntry } from "../services/active-task";

type ChatSendMessagePayload = SendMessagePayload & {
  resumeState?: ToolLoopResumeStateSnapshot | null;
};

export interface ChatHandlersDeps {
  runChatTask: (webContents: Electron.WebContents, payload: ChatSendMessagePayload) => Promise<unknown>;
  normalizeOptionalString: (input: unknown) => string | null;
  loadMatchingChatResumeSnapshot: (sessionId: string, workspace: string) => unknown;
  activeTasks: Map<string, ActiveTaskEntry>;
}

export function registerChatHandlers(deps: ChatHandlersDeps): void {
  ipcMain.handle(IPC_CHANNELS.chatSendMessage, async (event, payload: ChatSendMessagePayload) => {
    return deps.runChatTask(event.sender, payload);
  });

  ipcMain.handle(IPC_CHANNELS.chatGetResumeState, async (_event, payload: GetResumeStatePayload) => {
    const sessionId = deps.normalizeOptionalString(payload.sessionId) ?? "default-session";
    return {
      ok: true,
      resumeSnapshot: deps.loadMatchingChatResumeSnapshot(sessionId, payload.workspace)
    };
  });

  ipcMain.handle(IPC_CHANNELS.chatStopMessage, async (_event, payload: StopMessagePayload) => {
    const task = deps.activeTasks.get(payload.taskId);
    if (!task) {
      return { ok: false, status: "not_found" as const, error: "Task not found or already completed" };
    }

    if (task.status === "stopping") {
      return { ok: true, status: "already_stopping" as const };
    }

    task.status = "stopping";
    task.stopRequestedAt = Date.now();
    task.controller.abort();

    if (task.forceStop) {
      void task.forceStop().catch(() => {
        return;
      });
    }

    return { ok: true, status: "accepted" as const };
  });
}
