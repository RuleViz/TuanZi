import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { TerminalSessionSummary } from "../../shared/ipc-contracts";
import { IPC_CHANNELS } from "../../shared/ipc-channels";

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
  stderr: string;
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
  process: ChildProcessWithoutNullStreams;
  summary: TerminalSessionSummary;
  stdoutBuffer: string;
  pending: PendingCommand | null;
  closed: boolean;
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
  resize(_terminalId: string, _cols: number, _rows: number): Promise<void>;
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

  function createShellProcess(workspace: string): ChildProcessWithoutNullStreams {
    if (process.platform === "win32") {
      return spawn(
        "powershell.exe",
        ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "-"],
        { cwd: workspace, windowsHide: true, stdio: "pipe" }
      );
    }

    const shell = process.env.SHELL || "/bin/bash";
    return spawn(shell, ["--noprofile", "--norc"], {
      cwd: workspace,
      stdio: "pipe"
    });
  }

  function wireSession(session: TerminalSession): void {
    session.process.stdout.on("data", (chunk: Buffer | string) => {
      handleStdout(session, String(chunk));
    });
    session.process.stderr.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      if (session.pending) {
        session.pending.stderr += text;
      }
      emitData(session, text);
    });
    session.process.on("close", (code) => {
      session.summary.status = "exited";
      session.summary.exitCode = code;
      if (session.pending) {
        settlePending(session, {
          terminalId: session.terminalId,
          exitCode: code,
          stdout: session.pending.stdout,
          stderr: session.pending.stderr,
          timedOut: false,
          interrupted: true
        });
      }
      emitExit(session, code);
    });
  }

  function handleStdout(session: TerminalSession, chunk: string): void {
    session.stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = session.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const lineWithNewline = session.stdoutBuffer.slice(0, newlineIndex + 1);
      session.stdoutBuffer = session.stdoutBuffer.slice(newlineIndex + 1);
      const normalized = lineWithNewline.replace(/\r?\n$/, "");
      const match = normalized.match(/^__TUANZI_DONE__:(.+?):(-?\d+)$/);
      if (match && session.pending && session.pending.token === match[1]) {
        settlePending(session, {
          terminalId: session.terminalId,
          exitCode: Number.parseInt(match[2], 10),
          stdout: session.pending.stdout,
          stderr: session.pending.stderr,
          timedOut: false,
          interrupted: false
        });
        continue;
      }
      if (session.pending) {
        session.pending.stdout += lineWithNewline;
      }
      emitData(session, lineWithNewline);
    }
  }

  function settlePending(session: TerminalSession, result: TerminalCommandResult): void {
    const pending = session.pending;
    if (!pending) {
      return;
    }
    session.pending = null;
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    pending.abortCleanup?.();
    pending.resolve(result);
  }

  function rejectPending(session: TerminalSession, error: Error): void {
    const pending = session.pending;
    if (!pending) {
      return;
    }
    session.pending = null;
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    pending.abortCleanup?.();
    pending.reject(error);
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
        .join("\n");
      return [
        `try {`,
        `  Set-Location -LiteralPath '${escapedCwd}'`,
        envSetup,
        `  ${command}`,
        `} finally {`,
        `  $__tuanziExit = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }`,
        `  Write-Output "__TUANZI_DONE__:${token}:$($__tuanziExit)"`,
        `}`
      ].join("\n");
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

  async function createSession(inputData: { sessionId: string; workspace: string; title?: string }): Promise<TerminalSessionSummary> {
    const terminalId = randomUUID();
    const createdAt = new Date().toISOString();
    const session: TerminalSession = {
      terminalId,
      sessionId: inputData.sessionId,
      title: inputData.title?.trim() || `Terminal ${sessions.size + 1}`,
      workspace: inputData.workspace,
      createdAt,
      process: createShellProcess(inputData.workspace),
      summary: {
        terminalId,
        sessionId: inputData.sessionId,
        title: inputData.title?.trim() || `Terminal ${sessions.size + 1}`,
        workspace: inputData.workspace,
        status: "running",
        createdAt
      },
      stdoutBuffer: "",
      pending: null,
      closed: false
    };
    sessions.set(terminalId, session);
    wireSession(session);
    emitOpened(makeSummary(session));
    emitData(session, `[terminal ready in ${inputData.workspace}]\n`);
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
    if (session.summary.status !== "running") {
      throw new Error("Selected terminal is not running.");
    }
    if (inputData.signal?.aborted) {
      throw new Error("Interrupted by user");
    }

    const token = randomUUID();
    const wrapped = buildWrappedCommandWithEnv(token, inputData.cwd, inputData.command, inputData.env);
    emitData(session, `${promptPrefix()} ${inputData.command}\n`);

    return new Promise<TerminalCommandResult>((resolve, reject) => {
      const pending: PendingCommand = {
        token,
        stdout: "",
        stderr: "",
        resolve,
        reject,
        timeout: null,
        abortCleanup: null
      };

      if (inputData.timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          rejectPending(session, new Error(`Command timed out after ${inputData.timeoutMs}ms`));
        }, inputData.timeoutMs);
      }

      if (inputData.signal) {
        const onAbort = (): void => {
          rejectPending(session, new Error("Interrupted by user"));
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
      session.process.stdin.write(`${wrapped}\n`);
    });
  }

  async function write(terminalId: string, data: string): Promise<void> {
    const session = getSessionOrThrow(terminalId);
    if (session.summary.status !== "running") {
      throw new Error("Terminal is not running");
    }
    session.process.stdin.write(data);
  }

  async function resize(): Promise<void> {
    return;
  }

  async function close(terminalId: string): Promise<void> {
    const session = getSessionOrThrow(terminalId);
    sessions.delete(terminalId);
    session.closed = true;
    rejectPending(session, new Error("Terminal closed by user"));
    try {
      session.process.kill("SIGTERM");
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

function compactTitle(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return "Command";
  }
  return trimmed.length > 28 ? `${trimmed.slice(0, 28)}...` : trimmed;
}

function promptPrefix(): string {
  return process.platform === "win32" ? "PS>" : "$";
}
