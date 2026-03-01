import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asNumber, asString } from "../core/json-utils";
import { assertInsideWorkspace, ensureAbsolutePath } from "../core/path-utils";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 50_000;

export class RunCommandTool implements Tool {
  readonly definition = {
    name: "run_command",
    description: "Run a one-off terminal command and return stdout/stderr/exit code.",
    destructive: true,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to execute." },
        cwd: { type: "string", description: "Absolute working directory. Defaults to workspace root." },
        timeout_ms: { type: "number", description: "Timeout in milliseconds." },
        max_output_chars: { type: "number", description: "Max stdout/stderr characters to keep." }
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
      const absoluteCwd = ensureAbsolutePath(cwdInput, "cwd");
      assertInsideWorkspace(absoluteCwd, context.workspaceRoot);
      cwd = absoluteCwd;
    }

    const cwdStat = await fs.stat(cwd).catch(() => null);
    if (!cwdStat || !cwdStat.isDirectory()) {
      return { ok: false, error: `cwd is invalid: ${cwd}` };
    }

    const timeoutMs = clampInt(asNumber(input.timeout_ms) ?? DEFAULT_TIMEOUT_MS, 1000, 900_000);
    const maxOutputChars = clampInt(asNumber(input.max_output_chars) ?? DEFAULT_MAX_OUTPUT, 1000, 1_000_000);

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
    const execution = await executeShellCommand(command, cwd, timeoutMs, maxOutputChars);
    const durationMs = Date.now() - startedAt;

    return {
      ok: true,
      data: {
        command,
        cwd,
        exitCode: execution.exitCode,
        signal: execution.signal,
        timedOut: execution.timedOut,
        durationMs,
        stdout: execution.stdout,
        stderr: execution.stderr
      }
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
  maxOutputChars: number
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
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

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

function appendLimited(original: string, addition: string, maxLength: number): string {
  const combined = `${original}${addition}`;
  if (combined.length <= maxLength) {
    return combined;
  }
  return `${combined.slice(0, maxLength)}\n... output truncated ...`;
}
