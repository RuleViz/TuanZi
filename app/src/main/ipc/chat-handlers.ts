import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import type { GetResumeStatePayload, SendMessagePayload, StopMessagePayload } from "../../shared/ipc-contracts";

export interface ChatHandlersDeps {
  runChatTask: (webContents: Electron.WebContents, payload: SendMessagePayload) => Promise<unknown>;
  normalizeOptionalString: (input: unknown) => string | null;
  loadMatchingChatResumeSnapshot: (sessionId: string, workspace: string) => unknown;
  activeTasks: Map<string, AbortController>;
}

export function registerChatHandlers(deps: ChatHandlersDeps): void {
  ipcMain.handle(IPC_CHANNELS.chatSendMessage, async (event, payload: SendMessagePayload) => {
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
    console.log(`[IPC] Received chat:stopMessage for taskId=${payload.taskId}`);
    const controller = deps.activeTasks.get(payload.taskId);
    if (controller) {
      console.log(`[IPC] Aborting controller for taskId=${payload.taskId}`);
      controller.abort();
      return { ok: true };
    }
    console.log(`[IPC] Task not found for taskId=${payload.taskId}`);
    return { ok: false, error: "Task not found or already completed" };
  });
}
