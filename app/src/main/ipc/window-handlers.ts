import { BrowserWindow, dialog, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import type { ActiveTaskEntry } from "../services/active-task";

export interface WindowHandlersDeps {
  getMainWindow: () => BrowserWindow | null;
  closePerfLog: (event: string, fields?: Record<string, unknown>, options?: { highFrequency?: boolean }) => void;
  closePerfLogResources: (event: string, fields?: Record<string, unknown>) => void;
  activeTasks: Map<string, ActiveTaskEntry>;
  abortAllActiveTasks: (reason: string) => number;
  waitForActiveTasksToDrain: (timeoutMs: number) => Promise<{ remaining: number; elapsedMs: number }>;
  shutdownWaitTimeoutMs: number;
  scheduleCloseForceDestroy: (win: BrowserWindow, reason: string) => void;
}

function getSenderWindow(sender: Electron.WebContents): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(sender);
  if (!win || win.isDestroyed()) {
    return null;
  }
  return win;
}

export function registerWindowHandlers(deps: WindowHandlersDeps): void {
  ipcMain.handle(IPC_CHANNELS.windowMinimize, async (event) => {
    const win = getSenderWindow(event.sender);
    if (!win) {
      return { ok: false, error: "Window unavailable" };
    }
    win.minimize();
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.windowToggleMaximize, async (event) => {
    const win = getSenderWindow(event.sender);
    if (!win) {
      return { ok: false, error: "Window unavailable" };
    }
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return { ok: true, maximized: win.isMaximized() };
  });

  ipcMain.handle(IPC_CHANNELS.windowClose, async (event) => {
    const win = getSenderWindow(event.sender);
    if (!win) {
      return { ok: false, error: "Window unavailable" };
    }
    deps.closePerfLog("close_requested", { activeTasks: deps.activeTasks.size });
    deps.closePerfLogResources("close_requested_resources", { activeTasks: deps.activeTasks.size });

    if (!win.isDestroyed()) {
      win.hide();
    }

    if (deps.activeTasks.size > 0) {
      deps.abortAllActiveTasks("window_close");
      const drainResult = await deps.waitForActiveTasksToDrain(Math.min(deps.shutdownWaitTimeoutMs, 400));
      deps.closePerfLog("window_close_drain", {
        remaining: drainResult.remaining,
        elapsedMs: drainResult.elapsedMs
      });
    }
    deps.closePerfLog("close_calling_win_close");
    deps.scheduleCloseForceDestroy(win, "window_close_ipc");
    if (!win.isDestroyed()) {
      win.close();
    }
    deps.closePerfLog("close_returned_from_win_close");
    deps.closePerfLogResources("close_returned_from_win_close_resources", {
      activeTasks: deps.activeTasks.size
    });
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.windowIsMaximized, async (event) => {
    const win = getSenderWindow(event.sender);
    if (!win) {
      return { ok: false, error: "Window unavailable" };
    }
    return { ok: true, maximized: win.isMaximized() };
  });

  ipcMain.handle(IPC_CHANNELS.dialogSelectWorkspace, async () => {
    const mainWindow = deps.getMainWindow();
    if (!mainWindow) {
      return null;
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "选择工作目录"
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });
}
