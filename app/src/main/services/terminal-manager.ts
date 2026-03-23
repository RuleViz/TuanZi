import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as pty from "node-pty";
import type { TerminalSessionSummary } from "../../shared/ipc-contracts";
import { IPC_CHANNELS } from "../../shared/ipc-channels";

const PROCESS_TERMINATE_WAIT_MS = 400;
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
  token: string;
  stdout: string;
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
      if (session.pending) {
        settlePending(session, {
          terminalId: session.terminalId,
          exitCode,
          stdout: session.pending.stdout,
          stderr: "",
          timedOut: false,
          interrupted: true
        });
      }
      emitExit(session, exitCode);
    });
  }

  function handlePtyData(session: TerminalSession, chunk: string): void {
    if (!session.pending) {
      emitData(session, chunk);
      return;
    }

    session.outputBuffer += chunk;
    while (true) {
      const newlineIndex = session.outputBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const lineWithNewline = session.outputBuffer.slice(0, newlineIndex + 1);
      session.outputBuffer = session.outputBuffer.slice(newlineIndex + 1);
      const stripped = stripAnsi(lineWithNewline).replace(/\r?\n$/, "");
      const match = stripped.match(/^__TUANZI_DONE__:(.+?):(-?\d+)$/);
      if (match && session.pending && session.pending.token === match[1]) {
        // Don't emit the sentinel line to the renderer
        settlePending(session, {
          terminalId: session.terminalId,
          exitCode: Number.parseInt(match[2], 10),
          stdout: session.pending.stdout,
          stderr: "",
          timedOut: false,
          interrupted: false
        });
        // Flush any remaining buffer content after sentinel
        if (session.outputBuffer) {
          emitData(session, session.outputBuffer);
          session.outputBuffer = "";
        }
        continue;
      }
      if (session.pending) {
        session.pending.stdout += stripAnsi(lineWithNewline);
      }
      emitData(session, lineWithNewline);
    }
  }

  function settlePending(session: TerminalSession, result: TerminalCommandResult): void {
    const pending = takePending(session);
    if (!pending) {
      return;
    }
    pending.resolve(result);
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

  function buildWrappedCommandWithEnv(
    token: string,
    cwd: string,
    command: string,
    env: Record<string, string>
  ): string {
    if (process.platform === "win32") {
      const escapedCwd = cwd.replace(/'/g, "''");
      const envSetup = Object.entries(env)
        .map(([key, value]) => `$env:${key} = '${value.replace(/'/g, "''")}'`)
        .join("; ");
      return [
        `try {`,
        `  Set-Location -LiteralPath '${escapedCwd}'`,
        envSetup ? `  ; ${envSetup}` : "",
        `  ; ${command}`,
        `} finally {`,
        `  $__tuanziExit = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }`,
        `  ; Write-Output "__TUANZI_DONE__:${token}:$($__tuanziExit)"`,
        `}`
      ]
        .filter(Boolean)
        .join("\n");
    }

    const escapedCwd = cwd.replace(/'/g, `'\\''`);
    const envSetup = Object.entries(env)
      .map(([key, value]) => `export ${key}='${value.replace(/'/g, `'\\''`)}'`)
      .join("\n");
    return [
      `cd '${escapedCwd}'`,
      envSetup,
      `{`,
      command,
      `}`,
      `__TUANZI_EXIT_CODE=$?`,
      `printf '__TUANZI_DONE__:${token}:%s\\n' "$__TUANZI_EXIT_CODE"`
    ].join("\n");
  }

  function commandTerminator(): string {
    return "\r";
  }

  async function terminatePty(ptyRef: pty.IPty): Promise<void> {
    const pid = ptyRef.pid;
    if (!pid) {
      return;
    }

    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
          shell: false
        });
        let settled = false;
        const done = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          resolve();
        };
        const timeout = setTimeout(done, PROCESS_TERMINATE_WAIT_MS);
        killer.once("exit", done);
        killer.once("error", done);
      });
      return;
    }

    try {
      ptyRef.kill();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, PROCESS_TERMINATE_WAIT_MS);
      ptyRef.onExit(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async function recoverTerminalSession(
    session: TerminalSession,
    reason: "timeout" | "interrupt",
    timeoutMs: number
  ): Promise<{ recovered: boolean; message: string }> {
    const previousPty = session.pty;
    session.recovering = true;
    await terminatePty(previousPty);
    if (session.closed) {
      session.recovering = false;
      return { recovered: false, message: "Terminal already closed." };
    }

    try {
      const generation = session.ptyGeneration + 1;
      const replacement = createPty(session.workspace, session.cols, session.rows);
      session.pty = replacement;
      session.ptyGeneration = generation;
      session.summary.status = "running";
      session.summary.exitCode = undefined;
      session.outputBuffer = "";
      wirePty(session, replacement, generation);
      session.recovering = false;
      const detail =
        reason === "timeout"
          ? `Command timed out after ${timeoutMs}ms; terminal recovered and ready for next command.`
          : "Command interrupted by user; terminal recovered and ready for next command.";
      emitData(session, `\r\n[terminal recovered] ${detail}\r\n`);
      return { recovered: true, message: detail };
    } catch (error) {
      session.recovering = false;
      const message = error instanceof Error ? error.message : String(error);
      session.summary.status = "exited";
      session.summary.exitCode = null;
      emitData(session, `\r\n[terminal recovery failed] ${message}\r\n`);
      emitExit(session, null);
      return { recovered: false, message };
    }
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

    const token = randomUUID();
    const wrapped = buildWrappedCommandWithEnv(token, inputData.cwd, inputData.command, inputData.env);

    return new Promise<TerminalCommandResult>((resolve, reject) => {
      const pending: PendingCommand = {
        token,
        stdout: "",
        resolve,
        reject,
        timeout: null,
        abortCleanup: null
      };

      if (inputData.timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          const inflight = takePending(session);
          if (!inflight) {
            return;
          }
          void recoverTerminalSession(session, "timeout", inputData.timeoutMs).then((recovery) => {
            const details = [
              `Command timed out after ${inputData.timeoutMs}ms.`,
              recovery.recovered
                ? "Terminal recovered and remains available in workbench."
                : `Terminal recovery failed: ${recovery.message}`
            ].join("\n");
            inflight.resolve({
              terminalId: session.terminalId,
              exitCode: null,
              stdout: inflight.stdout,
              stderr: details,
              timedOut: true,
              interrupted: false
            });
          });
        }, inputData.timeoutMs);
      }

      if (inputData.signal) {
        const onAbort = (): void => {
          const inflight = takePending(session);
          if (!inflight) {
            return;
          }
          void recoverTerminalSession(session, "interrupt", inputData.timeoutMs).then((recovery) => {
            const details = [
              "Interrupted by user.",
              recovery.recovered
                ? "Terminal recovered and remains available in workbench."
                : `Terminal recovery failed: ${recovery.message}`
            ].join("\n");
            inflight.resolve({
              terminalId: session.terminalId,
              exitCode: null,
              stdout: inflight.stdout,
              stderr: details,
              timedOut: false,
              interrupted: true
            });
          });
        };
        if (inputData.signal.aborted) {
          onAbort();
          return;
        }
        inputData.signal.addEventListener("abort", onAbort, { once: true });
        pending.abortCleanup = () => {
          inputData.signal?.removeEventListener("abort", onAbort);
        };
      }

      session.pending = pending;
      session.outputBuffer = "";
      try {
        session.pty.write(`${wrapped}${commandTerminator()}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rejectPending(session, new Error(`Failed to dispatch command: ${message}`));
      }
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

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function compactTitle(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return "Command";
  }
  return trimmed.length > 28 ? `${trimmed.slice(0, 28)}...` : trimmed;
}
