import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { TerminalSessionSummary } from "../../shared/ipc-contracts";
import { IPC_CHANNELS } from "../../shared/ipc-channels";

const PROCESS_TERMINATE_WAIT_MS = 400;

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
  recovering: boolean;
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

  function wireSession(session: TerminalSession, processRef: ChildProcessWithoutNullStreams = session.process): void {
    processRef.stdout.on("data", (chunk: Buffer | string) => {
      if (session.process !== processRef || session.closed || session.recovering) {
        return;
      }
      handleStdout(session, String(chunk));
    });
    processRef.stderr.on("data", (chunk: Buffer | string) => {
      if (session.process !== processRef || session.closed || session.recovering) {
        return;
      }
      const text = String(chunk);
      if (session.pending) {
        session.pending.stderr += text;
      }
      emitData(session, text);
    });
    processRef.on("close", (code) => {
      if (session.process !== processRef) {
        return;
      }
      if (session.recovering) {
        return;
      }
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

  function commandTerminator(): string {
    // PowerShell's -Command - often waits for an extra blank line before executing multi-line blocks.
    return process.platform === "win32" ? "\n\n" : "\n";
  }

  async function waitForProcessExit(processRef: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (exited: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        processRef.removeListener("exit", onExit);
        processRef.removeListener("error", onError);
        resolve(exited);
      };
      const onExit = (): void => done(true);
      const onError = (): void => done(true);
      const timeout = setTimeout(() => done(false), Math.max(0, timeoutMs));
      processRef.once("exit", onExit);
      processRef.once("error", onError);
    });
  }

  async function terminateProcessTree(processRef: ChildProcessWithoutNullStreams): Promise<void> {
    const pid = processRef.pid;
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
      processRef.kill("SIGTERM");
    } catch {
      // ignore
    }
    const exitedByTerm = await waitForProcessExit(processRef, PROCESS_TERMINATE_WAIT_MS);
    if (exitedByTerm) {
      return;
    }
    try {
      processRef.kill("SIGKILL");
    } catch {
      // ignore
    }
    await waitForProcessExit(processRef, PROCESS_TERMINATE_WAIT_MS);
  }

  async function recoverTerminalSession(
    session: TerminalSession,
    reason: "timeout" | "interrupt",
    timeoutMs: number
  ): Promise<{ recovered: boolean; message: string }> {
    const previousProcess = session.process;
    session.recovering = true;
    await terminateProcessTree(previousProcess);
    if (session.closed) {
      session.recovering = false;
      return { recovered: false, message: "Terminal already closed." };
    }

    try {
      const replacement = createShellProcess(session.workspace);
      session.process = replacement;
      session.summary.status = "running";
      session.summary.exitCode = undefined;
      session.stdoutBuffer = "";
      wireSession(session, replacement);
      session.recovering = false;
      const detail =
        reason === "timeout"
          ? `Command timed out after ${timeoutMs}ms; terminal recovered and ready for next command.`
          : "Command interrupted by user; terminal recovered and ready for next command.";
      emitData(session, `[terminal recovered] ${detail}\n`);
      return { recovered: true, message: detail };
    } catch (error) {
      session.recovering = false;
      const message = error instanceof Error ? error.message : String(error);
      session.summary.status = "exited";
      session.summary.exitCode = null;
      emitData(session, `[terminal recovery failed] ${message}\n`);
      emitExit(session, null);
      return { recovered: false, message };
    }
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
      closed: false,
      recovering: false
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
            const stderr = inflight.stderr ? `${inflight.stderr}\n${details}` : details;
            inflight.resolve({
              terminalId: session.terminalId,
              exitCode: null,
              stdout: inflight.stdout,
              stderr,
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
            const stderr = inflight.stderr ? `${inflight.stderr}\n${details}` : details;
            inflight.resolve({
              terminalId: session.terminalId,
              exitCode: null,
              stdout: inflight.stdout,
              stderr,
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
      try {
        session.process.stdin.write(`${wrapped}${commandTerminator()}`);
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
