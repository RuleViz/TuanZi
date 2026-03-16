import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asNumber, asString } from "../core/json-utils";
import { assertInsideWorkspace, resolveSafePath } from "../core/path-utils";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 3_000;
const MIDDLE_TRUNCATION_MARKER = "\n[... middle output omitted ...]\n";

export class RunCommandTool implements Tool {
  readonly definition = {
    name: "run_command",
    description: "Run a one-off terminal command with sanitized and truncated output.",
    destructive: true,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to execute." },
        cwd: {
          type: "string",
          description: "Working directory (relative to workspace root or absolute). Defaults to workspace root."
        },
        timeout_ms: { type: "number", description: "Timeout in milliseconds." },
        max_output_chars: { type: "number", description: "Max stdout/stderr characters to keep." },
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
    const maxOutputChars = clampInt(asNumber(input.max_output_chars) ?? DEFAULT_MAX_OUTPUT, 500, 20_000);
    const parseJsonOutput = input.parse_json_output === true;
    const envOverrides = parseEnvOverrides(input.env);
    if (!envOverrides.ok) {
      return { ok: false, error: envOverrides.error };
    }

    const policyDecision = context.policyEngine?.evaluateTool(this.definition.name, input) ?? {
      decision: "ask" as const,
      reason: "No policy engine configured."
    };
    if (policyDecision.decision === "deny") {
      return { ok: false, error: `Policy denied run_command: ${policyDecision.reason}` };
    }

    const risk = isDangerousCommand(command) ? "high" : "medium";
    if (policyDecision.decision === "ask") {
      const approval = await context.approvalGate.approve({
        action: `run_command => ${command}`,
        risk,
        preview: `cwd: ${cwd}`
      });
      if (!approval.approved) {
        return { ok: false, error: approval.reason ?? "Command execution rejected." };
      }
    }

    const startedAt = Date.now();
    const execution = await executeShellCommand(
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
      durationMs,
      stdout,
      stderr,
      parsedOutput
    };

    const failed = execution.timedOut || execution.exitCode !== 0;
    if (failed) {
      const exitDisplay = execution.timedOut ? "timeout" : String(execution.exitCode);
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
  maxOutputChars: number,
  envOverrides: Record<string, string>,
  signal?: AbortSignal
): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: {
        ...process.env,
        ...envOverrides
      },
      signal
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        resolve({
          exitCode: 1,
          signal: "SIGTERM",
          timedOut: false,
          stdout,
          stderr: stderr + "\n[Process interrupted by user]"
        });
      } else {
        resolve({
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout,
          stderr: stderr + "\n[Process error: " + err.message + "]"
        });
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendLimited(stdout, String(chunk), maxOutputChars);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendLimited(stderr, String(chunk), maxOutputChars);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr
      });
    });
  });
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

function appendLimited(original: string, addition: string, maxLength: number): string {
  const combined = `${original}${stripAnsi(addition)}`;
  if (combined.length <= maxLength) {
    return combined;
  }
  return truncateMiddle(combined, maxLength);
}

function sanitizeOutput(text: string, maxLength: number): string {
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
