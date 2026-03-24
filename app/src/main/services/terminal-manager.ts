import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as pty from "node-pty";
import type { TerminalSessionSummary } from "../../shared/ipc-contracts";
import { IPC_CHANNELS } from "../../shared/ipc-channels";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

export interface TerminalCommandResult {
  terminalId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  interrupted: boolean;
}

interface PendingCommand {
  resolve: (value: TerminalCommandResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout | null;
  abortCleanup: (() => void) | null;
}

interface TerminalSession {
  terminalId: string;
  sessionId: string;
  title: string;
  workspace: string;
  createdAt: string;
  pty: pty.IPty;
  ptyGeneration: number;
  summary: TerminalSessionSummary;
  outputBuffer: string;
  pending: PendingCommand | null;
  closed: boolean;
  recovering: boolean;
  cols: number;
  rows: number;
}

export interface TerminalManager {
  createSession(input: { sessionId: string; workspace: string; title?: string }): Promise<TerminalSessionSummary>;
  executeCommand(input: {
    sessionId: string;
    workspace: string;
    cwd: string;
    command: string;
    env: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
    terminalId?: string;
    title?: string;
  }): Promise<TerminalCommandResult>;
  write(terminalId: string, data: string): Promise<void>;
  resize(terminalId: string, cols: number, rows: number): Promise<void>;
  close(terminalId: string): Promise<void>;
  closeAll(): Promise<void>;
}

export function createTerminalManager(input: {
  sendToRenderer: (channel: string, payload: unknown) => void;
  log?: (message: string) => void;
}): TerminalManager {
  const sessions = new Map<string, TerminalSession>();

  function emitOpened(summary: TerminalSessionSummary): void {
    input.sendToRenderer(IPC_CHANNELS.terminalOpened, { terminal: summary });
  }

  function emitData(session: TerminalSession, chunk: string): void {
    if (!chunk) {
      return;
    }
    input.sendToRenderer(IPC_CHANNELS.terminalData, {
      terminalId: session.terminalId,
      sessionId: session.sessionId,
      chunk
    });
  }

  function emitExit(session: TerminalSession, exitCode: number | null): void {
    input.sendToRenderer(IPC_CHANNELS.terminalExit, {
      terminalId: session.terminalId,
      sessionId: session.sessionId,
      exitCode
    });
  }

  function emitClosed(session: TerminalSession): void {
    input.sendToRenderer(IPC_CHANNELS.terminalClosed, {
      terminalId: session.terminalId,
      sessionId: session.sessionId
    });
  }

  function makeSummary(session: TerminalSession): TerminalSessionSummary {
    return {
      terminalId: session.terminalId,
      sessionId: session.sessionId,
      title: session.title,
      workspace: session.workspace,
      status: session.summary.status,
      createdAt: session.createdAt,
      exitCode: session.summary.exitCode
    };
  }

  function createPty(workspace: string, cols: number, rows: number): pty.IPty {
    if (process.platform === "win32") {
      return pty.spawn("powershell.exe", ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass"], {
        name: "xterm-256color",
        cwd: workspace,
        cols,
        rows,
        useConpty: true
      });
    }

    const shell = process.env.SHELL || "/bin/bash";
    return pty.spawn(shell, [], {
      name: "xterm-256color",
      cwd: workspace,
      cols,
      rows
    });
  }

  function wirePty(session: TerminalSession, ptyRef: pty.IPty, generation: number): void {
    ptyRef.onData((data: string) => {
      if (session.ptyGeneration !== generation || session.closed || session.recovering) {
        return;
      }
      handlePtyData(session, data);
    });
    ptyRef.onExit(({ exitCode }) => {
      if (session.ptyGeneration !== generation) {
        return;
      }
      if (session.recovering) {
        return;
      }
      session.summary.status = "exited";
      session.summary.exitCode = exitCode;
      emitExit(session, exitCode);
    });
  }

  function handlePtyData(session: TerminalSession, chunk: string): void {
    if (session.pending) {
      return;
    }
    emitData(session, chunk);
  }

  function rejectPending(session: TerminalSession, error: Error): void {
    const pending = takePending(session);
    if (!pending) {
      return;
    }
    pending.reject(error);
  }

  function takePending(session: TerminalSession): PendingCommand | null {
    const pending = session.pending;
    if (!pending) {
      return null;
    }
    session.pending = null;
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    pending.abortCleanup?.();
    return pending;
  }

  async function createSession(inputData: { sessionId: string; workspace: string; title?: string }): Promise<TerminalSessionSummary> {
    const terminalId = randomUUID();
    const createdAt = new Date().toISOString();
    const title = inputData.title?.trim() || `Terminal ${sessions.size + 1}`;
    const generation = 0;
    const ptyInstance = createPty(inputData.workspace, DEFAULT_COLS, DEFAULT_ROWS);
    const session: TerminalSession = {
      terminalId,
      sessionId: inputData.sessionId,
      title,
      workspace: inputData.workspace,
      createdAt,
      pty: ptyInstance,
      ptyGeneration: generation,
      summary: {
        terminalId,
        sessionId: inputData.sessionId,
        title,
        workspace: inputData.workspace,
        status: "running",
        createdAt
      },
      outputBuffer: "",
      pending: null,
      closed: false,
      recovering: false,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS
    };
    sessions.set(terminalId, session);
    wirePty(session, ptyInstance, generation);
    emitOpened(makeSummary(session));
    return makeSummary(session);
  }

  function getSessionOrThrow(terminalId: string): TerminalSession {
    const session = sessions.get(terminalId);
    if (!session) {
      throw new Error("Terminal session not found");
    }
    return session;
  }

  async function executeCommand(inputData: {
    sessionId: string;
    workspace: string;
    cwd: string;
    command: string;
    env: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
    terminalId?: string;
    title?: string;
  }): Promise<TerminalCommandResult> {
    const session = inputData.terminalId
      ? getSessionOrThrow(inputData.terminalId)
      : getSessionOrThrow((await createSession({
          sessionId: inputData.sessionId,
          workspace: inputData.workspace,
          title: inputData.title || compactTitle(inputData.command)
        })).terminalId);

    if (session.pending) {
      throw new Error("Selected terminal is busy.");
    }
    if (session.recovering) {
      throw new Error("Selected terminal is recovering from an interrupted command.");
    }
    if (session.summary.status !== "running") {
      throw new Error("Selected terminal is not running.");
    }
    if (inputData.signal?.aborted) {
      throw new Error("Interrupted by user");
    }

    const shell = getDefaultShell();
    const shellArgs = getShellArgs(shell, inputData.command);
    const mergedEnv = {
      ...process.env,
      ...inputData.env,
      TERM: "xterm-256color",
      PAGER: "cat",
      GIT_PAGER: "cat",
      SYSTEMD_PAGER: "",
      MANPAGER: "cat"
    };

    const isCmd = process.platform === "win32" && shell.toLowerCase().includes("cmd");
    const child = isCmd
      ? spawn(shell, shellArgs, {
          cwd: inputData.cwd,
          env: mergedEnv,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          shell: true
        })
      : spawn(shell, shellArgs, {
          cwd: inputData.cwd,
          env: mergedEnv,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: process.platform !== "win32"
        });

    emitData(session, `\x1b[90m$ ${inputData.command}\x1b[0m\r\n`);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let interrupted = false;
    let exited = false;

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = normalizeNewlines(String(chunk));
      stdout += text;
      emitData(session, text);
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = normalizeNewlines(String(chunk));
      stderr += text;
      emitData(session, text);
    });

    const killChild = (): void => {
      if (exited || child.pid === undefined) {
        return;
      }
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
          shell: false
        });
        return;
      }
      try {
        if (child.pid) {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }
    };

    return new Promise<TerminalCommandResult>((resolve) => {
      let settled = false;
      const settle = (result: TerminalCommandResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        session.pending = null;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        if (inputData.signal) {
          inputData.signal.removeEventListener("abort", onAbort);
        }
        resolve(result);
      };

      const onAbort = (): void => {
        interrupted = true;
        killChild();
      };

      const timeoutTimer = inputData.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killChild();
          }, inputData.timeoutMs)
        : null;

      if (inputData.signal) {
        if (inputData.signal.aborted) {
          interrupted = true;
          killChild();
        } else {
          inputData.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      session.pending = {
        resolve: (result: TerminalCommandResult) => settle(result),
        reject: (error: Error) => {
          killChild();
          settle({
            terminalId: session.terminalId,
            exitCode: 1,
            stdout,
            stderr: `${stderr}\n${error.message}`,
            timedOut,
            interrupted: true
          });
        },
        timeout: timeoutTimer,
        abortCleanup: inputData.signal
          ? () => { inputData.signal?.removeEventListener("abort", onAbort); }
          : null
      };

      child.on("error", (err: Error) => {
        exited = true;
        stderr += `\n[Process error: ${err.message}]`;
        emitData(session, `\r\n\x1b[31m[Process error: ${err.message}]\x1b[0m\r\n`);
        settle({
          terminalId: session.terminalId,
          exitCode: 1,
          stdout,
          stderr,
          timedOut,
          interrupted
        });
      });

      child.on("close", (exitCode) => {
        exited = true;
        emitData(session, `\r\n\x1b[90m[exit: ${exitCode ?? "null"}]\x1b[0m\r\n`);
        settle({
          terminalId: session.terminalId,
          exitCode,
          stdout,
          stderr,
          timedOut,
          interrupted
        });
      });
    });
  }

  async function write(terminalId: string, data: string): Promise<void> {
    const session = getSessionOrThrow(terminalId);
    if (session.recovering) {
      throw new Error("Terminal is recovering from an interrupted command");
    }
    if (session.summary.status !== "running") {
      throw new Error("Terminal is not running");
    }
    session.pty.write(data);
  }

  async function resize(terminalId: string, cols: number, rows: number): Promise<void> {
    const session = getSessionOrThrow(terminalId);
    if (session.summary.status !== "running") {
      return;
    }
    session.cols = cols;
    session.rows = rows;
    try {
      session.pty.resize(cols, rows);
    } catch {
      // ignore resize errors on already-exited processes
    }
  }

  async function close(terminalId: string): Promise<void> {
    const session = getSessionOrThrow(terminalId);
    sessions.delete(terminalId);
    session.closed = true;
    rejectPending(session, new Error("Terminal closed by user"));
    try {
      session.pty.kill();
    } catch {
      // ignore
    }
    emitClosed(session);
  }

  async function closeAll(): Promise<void> {
    for (const terminalId of [...sessions.keys()]) {
      await close(terminalId).catch(() => {
        return;
      });
    }
  }

  return {
    createSession,
    executeCommand,
    write,
    resize,
    close,
    closeAll
  };
}

function getDefaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "cmd.exe";
  }
  return process.env.SHELL || "/bin/bash";
}

function getShellArgs(shell: string, command: string): string[] {
  if (process.platform === "win32") {
    if (shell.toLowerCase().includes("powershell") || shell.toLowerCase().includes("pwsh")) {
      return ["-NoLogo", "-NoProfile", "-Command", command];
    }
    return ["/c", command];
  }
  return ["-l", "-c", command];
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

function compactTitle(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return "Command";
  }
  return trimmed.length > 28 ? `${trimmed.slice(0, 28)}...` : trimmed;
}
