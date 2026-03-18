import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import type {
  TerminalClosePayload,
  TerminalCreatePayload,
  TerminalResizePayload,
  TerminalWritePayload
} from "../../shared/ipc-contracts";
import type { TerminalManager } from "../services/terminal-manager";

export interface TerminalHandlersDeps {
  terminalManager: TerminalManager;
}

export function registerTerminalHandlers(deps: TerminalHandlersDeps): void {
  ipcMain.handle(IPC_CHANNELS.terminalCreate, async (_event, payload: TerminalCreatePayload) => {
    try {
      const terminal = await deps.terminalManager.createSession(payload);
      return { ok: true, terminal };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.terminalWrite, async (_event, payload: TerminalWritePayload) => {
    try {
      await deps.terminalManager.write(payload.terminalId, payload.data);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.terminalResize, async (_event, payload: TerminalResizePayload) => {
    try {
      await deps.terminalManager.resize(payload.terminalId, payload.cols, payload.rows);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.terminalClose, async (_event, payload: TerminalClosePayload) => {
    try {
      await deps.terminalManager.close(payload.terminalId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
