import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asNumber, asString } from "../core/json-utils";
import { assertInsideWorkspace, resolveSafePath } from "../core/path-utils";

const DEFAULT_TIMEOUT_MS = 120_000;
const FORCE_KILL_GRACE_MS = 2_500;
const MIDDLE_TRUNCATION_MARKER = "\n[... middle output omitted ...]\n";

export class BashTool implements Tool {
  readonly definition = {
    name: "bash",
    description: "Run a one-off terminal command with sanitized output. Returns full stdout/stderr unless max_output_chars is provided.",
    destructive: true,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to execute." },
        cwd: {
          type: "string",
          description: "Working directory (relative to workspace root or absolute). Defaults to workspace root."
        },
        terminal_id: {
          type: "string",
          description: "Optional terminal session id to reuse. If omitted in desktop mode, a new terminal container is created."
        },
        terminal_title: {
          type: "string",
          description: "Optional display title when a new terminal container is created."
        },
        timeout_ms: { type: "number", description: "Timeout in milliseconds." },
        max_output_chars: {
          type: "number",
          description: "Optional max stdout/stderr characters to keep. If omitted, returns full output."
        },
        parse_json_output: { type: "boolean", description: "Attempt to parse stdout as JSON." },
        env: {
          type: "object",
          description: "Additional environment variables as key/value strings.",
          additionalProperties: { type: "string" }
        }
      },
      required: ["command"],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const command = asString(input.command);
    if (!command || command.trim() === "") {
      return { ok: false, error: "command is required and must be a non-empty string." };
    }

    let cwd = context.workspaceRoot;
    const cwdInput = asString(input.cwd);
    if (cwdInput) {
      const absoluteCwd = resolveSafePath(cwdInput, context.workspaceRoot, "cwd");
      assertInsideWorkspace(absoluteCwd, context.workspaceRoot);
      cwd = absoluteCwd;
    }

    const cwdStat = await fs.stat(cwd).catch(() => null);
    if (!cwdStat || !cwdStat.isDirectory()) {
      return { ok: false, error: `cwd is invalid: ${cwd}` };
    }

    const timeoutMs = clampInt(asNumber(input.timeout_ms) ?? DEFAULT_TIMEOUT_MS, 1000, 900_000);
    const maxOutputChars =
      input.max_output_chars === undefined ? null : clampInt(asNumber(input.max_output_chars) ?? 0, 500, 20_000);
    const parseJsonOutput = input.parse_json_output === true;
    const terminalId = asString(input.terminal_id) ?? undefined;
    const terminalTitle = asString(input.terminal_title) ?? undefined;
    const envOverrides = parseEnvOverrides(input.env);
    if (!envOverrides.ok) {
      return { ok: false, error: envOverrides.error };
    }

    const policyDecision = context.policyEngine?.evaluateTool(this.definition.name, input) ?? {
      decision: "ask" as const,
      reason: "No policy engine configured."
    };
    if (policyDecision.decision === "deny") {
      return { ok: false, error: `Policy denied bash: ${policyDecision.reason}` };
    }

    const risk = isDangerousCommand(command) ? "high" : "medium";
    if (policyDecision.decision === "ask") {
      const approval = await context.approvalGate.approve({
        action: `bash => ${command}`,
        risk,
        preview: `cwd: ${cwd}`
      });
      if (!approval.approved) {
        return { ok: false, error: approval.reason ?? "Command execution rejected." };
      }
    }

    const startedAt = Date.now();
    const execution = context.terminalBridge && context.sessionId
      ? await executeTerminalCommand(
          {
            command,
            cwd,
            timeoutMs,
            signal: context.signal,
            sessionId: context.sessionId,
            workspaceRoot: context.workspaceRoot,
            terminalId,
            terminalTitle,
            env: envOverrides.value
          },
          context
        )
      : await executeShellCommand(
          command,
          cwd,
          timeoutMs,
          maxOutputChars,
          envOverrides.value,
          context.signal
        );
    const durationMs = Date.now() - startedAt;
    const stdout = sanitizeOutput(execution.stdout, maxOutputChars);
    const stderr = sanitizeOutput(execution.stderr, maxOutputChars);
    const parsedOutput = parseJsonOutput ? tryParseJson(stdout) : undefined;

    const payload = {
      command,
      cwd,
      exitCode: execution.exitCode,
      signal: execution.signal,
      timedOut: execution.timedOut,
      interrupted: execution.interrupted,
      forceKilled: execution.forceKilled,
      terminalId: execution.terminalId,
      durationMs,
      stdout,
      stderr,
      parsedOutput
    };

    const failed = execution.timedOut || execution.interrupted || execution.exitCode !== 0;
    if (failed) {
      const exitDisplay = execution.interrupted ? "interrupted" : execution.timedOut ? "timeout" : String(execution.exitCode);
      const stdoutSection = stdout ? `\nstdout:\n${stdout}` : "";
      return {
        ok: false,
        error: `Command failed (Exit Code ${exitDisplay}). stderr:\n${stderr || "[empty]"}${stdoutSection}`,
        data: payload
      };
    }

    return {
      ok: true,
      data: payload
    };
  }
}

function clampInt(value: number, min: number, max: number): number {
  const integer = Math.floor(value);
  return Math.max(min, Math.min(max, integer));
}

function isDangerousCommand(command: string): boolean {
  const dangerousPatterns = [
    /\brm\s+-rf\b/i,
    /\bdel\s+\/f\b/i,
    /\bformat\b/i,
    /\bmkfs\b/i,
    /\bshutdown\b/i,
    /\breboot\b/i,
    /\bgit\s+reset\s+--hard\b/i
  ];
  return dangerousPatterns.some((pattern) => pattern.test(command));
}

async function executeShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputChars: number | null,
  envOverrides: Record<string, string>,
  signal?: AbortSignal
): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  interrupted: boolean;
  forceKilled: boolean;
  terminalId?: string;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: {
        ...process.env,
        CI: "1",
        NPM_CONFIG_YES: "true",
        ...envOverrides
      }
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let interrupted = false;
    let forceKilled = false;
    let settled = false;
    let closeSignal: NodeJS.Signals | null = null;

    const resolveOnce = (payload: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      interrupted: boolean;
      forceKilled: boolean;
      stdout: string;
      stderr: string;
    }): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(payload);
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const killChildTreeForcefully = (): void => {
      if (forceKilled || child.pid === undefined) {
        return;
      }
      forceKilled = true;

      if (process.platform === "win32") {
        void spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
          shell: false
        });
        return;
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore kill errors
      }
    };

    const requestStop = (reason: "timeout" | "interrupt"): void => {
      if (reason === "timeout") {
        timedOut = true;
      } else {
        interrupted = true;
      }
      try {
        closeSignal = "SIGTERM";
        child.kill("SIGTERM");
      } catch {
        // ignore kill errors
      }
      clearTimeout(forceKillTimer);
      forceKillTimer = setTimeout(() => {
        killChildTreeForcefully();
      }, FORCE_KILL_GRACE_MS);
    };

    const onAbort = (): void => {
      requestStop("interrupt");
    };

    child.on("error", (err: Error) => {
      cleanup();
      if (err.name !== "AbortError") {
        stderr = appendLimited(stderr, `\n[Process error: ${err.message}]`, maxOutputChars);
      }
      if (err.name === "AbortError") {
        interrupted = true;
      }
      resolveOnce({
        exitCode: 1,
        signal: closeSignal,
        timedOut,
        interrupted,
        forceKilled,
        stdout,
        stderr
      });
    });

    const timer = setTimeout(() => {
      requestStop("timeout");
    }, timeoutMs);
    let forceKillTimer = setTimeout(() => {
      return;
    }, 0);
    clearTimeout(forceKillTimer);

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendLimited(stdout, String(chunk), maxOutputChars);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendLimited(stderr, String(chunk), maxOutputChars);
    });

    child.on("close", (exitCode, signal) => {
      cleanup();
      resolveOnce({
        exitCode,
        signal: signal ?? closeSignal,
        timedOut,
        interrupted,
        forceKilled,
        stdout,
        stderr
      });
    });
  });
}

async function executeTerminalCommand(
  input: {
    sessionId: string;
    workspaceRoot: string;
    cwd: string;
    command: string;
    env: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
    terminalId?: string;
    terminalTitle?: string;
  },
  context: ToolExecutionContext
): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  interrupted: boolean;
  forceKilled: boolean;
  terminalId: string;
  stdout: string;
  stderr: string;
}> {
  const bridge = context.terminalBridge;
  if (!bridge) {
    throw new Error("Terminal bridge is not configured.");
  }
  try {
    const result = await bridge.executeCommand({
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      cwd: input.cwd,
      command: input.command,
      env: input.env,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      terminalId: input.terminalId,
      title: input.terminalTitle
    });
    return {
      exitCode: result.exitCode,
      signal: null,
      timedOut: result.timedOut,
      interrupted: result.interrupted,
      forceKilled: false,
      terminalId: result.terminalId,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const interrupted = message === "Interrupted by user";
    return {
      exitCode: interrupted ? null : 1,
      signal: null,
      timedOut: false,
      interrupted,
      forceKilled: false,
      terminalId: input.terminalId ?? "unknown-terminal",
      stdout: "",
      stderr: `Terminal bridge error: ${message}`
    };
  }
}

function parseEnvOverrides(value: unknown): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: {} };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "env must be an object with string values." };
  }
  const parsed: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") {
      return { ok: false, error: `env.${key} must be a string.` };
    }
    parsed[key] = raw;
  }
  return { ok: true, value: parsed };
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function appendLimited(original: string, addition: string, maxLength: number | null): string {
  const combined = `${original}${stripAnsi(addition)}`;
  if (maxLength === null || combined.length <= maxLength) {
    return combined;
  }
  return truncateMiddle(combined, maxLength);
}

function sanitizeOutput(text: string, maxLength: number | null): string {
  if (maxLength === null) {
    return stripAnsi(text);
  }
  return truncateMiddle(stripAnsi(text), maxLength);
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function truncateMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  const available = maxLength - MIDDLE_TRUNCATION_MARKER.length;
  if (available <= 0) {
    return text.slice(0, maxLength);
  }
  const headLength = Math.ceil(available * 0.6);
  const tailLength = Math.floor(available * 0.4);
  return `${text.slice(0, headLength)}${MIDDLE_TRUNCATION_MARKER}${text.slice(text.length - tailLength)}`;
}
