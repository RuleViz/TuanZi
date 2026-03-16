import { spawn } from "node:child_process";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asNumber, asString } from "../core/json-utils";

type CheckpointAction = "create" | "restore" | "list" | "diff" | "drop";

export class CheckpointTool implements Tool {
  readonly definition = {
    name: "checkpoint",
    description: "Create, list, restore, diff, or drop project snapshots using git stash.",
    destructive: true,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "restore", "list", "diff", "drop"],
          description: "Checkpoint action."
        },
        label: { type: "string", description: "Optional label for create action." },
        index: { type: "number", description: "Stash index for restore/diff/drop (default 0)." }
      },
      required: ["action"],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const actionValue = asString(input.action);
    if (!actionValue || !isCheckpointAction(actionValue)) {
      return { ok: false, error: "action is required. Valid actions: create, restore, list, diff, drop." };
    }

    const gitCheck = await runGit(["rev-parse", "--git-dir"], context.workspaceRoot);
    if (!gitCheck.ok) {
      return { ok: false, error: "Not a git repository. checkpoint requires a git workspace." };
    }

    const policyDecision = context.policyEngine?.evaluateTool(this.definition.name, input) ?? {
      decision: "ask" as const,
      reason: "No policy engine configured."
    };
    if (policyDecision.decision === "deny") {
      return { ok: false, error: `Policy denied checkpoint: ${policyDecision.reason}` };
    }
    if (policyDecision.decision === "ask") {
      const approval = await context.approvalGate.approve({
        action: `checkpoint ${actionValue}`,
        risk: actionRisk(actionValue),
        preview: actionPreview(actionValue)
      });
      if (!approval.approved) {
        return { ok: false, error: approval.reason ?? "Checkpoint action rejected." };
      }
    }

    if (actionValue === "create") {
      const label = (asString(input.label) ?? `checkpoint-${Date.now()}`).trim() || `checkpoint-${Date.now()}`;
      const message = `tuanzi-checkpoint: ${label}`;
      const pushed = await runGit(["stash", "push", "--include-untracked", "-m", message], context.workspaceRoot);
      if (!pushed.ok) {
        return { ok: false, error: `Failed to create checkpoint: ${trimStderr(pushed.stderr)}` };
      }

      const applied = await runGit(["stash", "apply", "stash@{0}"], context.workspaceRoot);
      if (!applied.ok) {
        return {
          ok: false,
          error: `Checkpoint created but failed to restore working tree via stash apply: ${trimStderr(applied.stderr)}`,
          data: { action: "created", label, createdRef: "stash@{0}" }
        };
      }

      return {
        ok: true,
        data: {
          action: "created",
          label,
          createdRef: "stash@{0}",
          message: pushed.stdout.trim()
        }
      };
    }

    if (actionValue === "list") {
      const listed = await runGit(["stash", "list"], context.workspaceRoot);
      if (!listed.ok) {
        return { ok: false, error: `Failed to list checkpoints: ${trimStderr(listed.stderr)}` };
      }
      const checkpoints = listed.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const match = line.match(/^stash@\{(\d+)\}:\s*(.+)$/);
          if (!match) {
            return null;
          }
          return {
            index: Number.parseInt(match[1], 10),
            description: match[2]
          };
        })
        .filter((item): item is { index: number; description: string } => item !== null)
        .filter((item) => item.description.includes("tuanzi-checkpoint"));

      return {
        ok: true,
        data: {
          action: "list",
          total: checkpoints.length,
          checkpoints
        }
      };
    }

    const index = clampInt(asNumber(input.index) ?? 0, 0, 1000);
    const ref = `stash@{${index}}`;

    if (actionValue === "diff") {
      const diffResult = await runGit(["stash", "show", "-p", ref], context.workspaceRoot);
      if (!diffResult.ok) {
        return { ok: false, error: `Failed to show checkpoint diff: ${trimStderr(diffResult.stderr)}` };
      }
      const diff = truncate(diffResult.stdout, 8000);
      return { ok: true, data: { action: "diff", index, ref, diff } };
    }

    if (actionValue === "restore") {
      const checkout = await runGit(["checkout", "--", "."], context.workspaceRoot);
      if (!checkout.ok) {
        return { ok: false, error: `Failed to clean tracked files before restore: ${trimStderr(checkout.stderr)}` };
      }
      const clean = await runGit(["clean", "-fd"], context.workspaceRoot);
      if (!clean.ok) {
        return { ok: false, error: `Failed to clean untracked files before restore: ${trimStderr(clean.stderr)}` };
      }
      const applied = await runGit(["stash", "apply", ref], context.workspaceRoot);
      if (!applied.ok) {
        return { ok: false, error: `Failed to restore checkpoint ${ref}: ${trimStderr(applied.stderr)}` };
      }
      return { ok: true, data: { action: "restore", index, ref } };
    }

    const dropped = await runGit(["stash", "drop", ref], context.workspaceRoot);
    if (!dropped.ok) {
      return { ok: false, error: `Failed to drop checkpoint ${ref}: ${trimStderr(dropped.stderr)}` };
    }
    return { ok: true, data: { action: "drop", index, ref, message: dropped.stdout.trim() } };
  }
}

function isCheckpointAction(value: string): value is CheckpointAction {
  return value === "create" || value === "restore" || value === "list" || value === "diff" || value === "drop";
}

function actionRisk(action: CheckpointAction): "low" | "medium" | "high" {
  if (action === "restore" || action === "drop") {
    return "high";
  }
  if (action === "create") {
    return "medium";
  }
  return "low";
}

function actionPreview(action: CheckpointAction): string {
  if (action === "restore") {
    return "Will discard current uncommitted workspace changes before applying stash snapshot.";
  }
  if (action === "drop") {
    return "Will permanently remove a stash checkpoint.";
  }
  if (action === "create") {
    return "Will create a git stash snapshot and restore current working tree.";
  }
  return "Read-only checkpoint operation.";
}

function clampInt(value: number, min: number, max: number): number {
  const integer = Math.floor(value);
  return Math.max(min, Math.min(max, integer));
}

function trimStderr(stderr: string): string {
  const text = stderr.trim();
  return text || "[empty]";
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...(truncated)`;
}

async function runGit(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      env: process.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        code
      });
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`,
        code: null
      });
    });
  });
}
