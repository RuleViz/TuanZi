import { promises as fs } from "node:fs";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asString } from "../core/json-utils";
import { assertInsideWorkspace, ensureAbsolutePath } from "../core/path-utils";

export class DeleteFileTool implements Tool {
  readonly definition = {
    name: "delete_file",
    description: "Delete a file or an empty directory by absolute path.",
    destructive: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to file or empty directory." }
      },
      required: ["path"],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const pathValue = asString(input.path);
    if (!pathValue) {
      return { ok: false, error: "path is required and must be a string." };
    }

    const absolutePath = ensureAbsolutePath(pathValue);
    assertInsideWorkspace(absolutePath, context.workspaceRoot);

    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat) {
      return { ok: false, error: `Path does not exist: ${absolutePath}` };
    }

    const risk = stat.isDirectory() ? "high" : "medium";
    const policyDecision = context.policyEngine?.evaluateTool(this.definition.name, input) ?? {
      decision: "ask" as const,
      reason: "No policy engine configured."
    };
    if (policyDecision.decision === "deny") {
      return { ok: false, error: `Policy denied delete_file: ${policyDecision.reason}` };
    }
    if (policyDecision.decision === "ask") {
      const approval = await context.approvalGate.approve({
        action: `delete_file => ${absolutePath}`,
        risk,
        preview: stat.isDirectory() ? "Directory deletion requested." : "File deletion requested."
      });
      if (!approval.approved) {
        return { ok: false, error: approval.reason ?? "Delete rejected." };
      }
    }

    let backupPath: string | null = null;
    if (stat.isFile()) {
      backupPath = await context.backupManager.backupFile(absolutePath);
      await fs.rm(absolutePath, { force: true });
    } else if (stat.isDirectory()) {
      const children = await fs.readdir(absolutePath);
      if (children.length > 0) {
        return { ok: false, error: "Only empty directories can be deleted in MVP." };
      }
      await fs.rmdir(absolutePath);
    } else {
      return { ok: false, error: "Unsupported file type for deletion." };
    }

    return {
      ok: true,
      data: {
        deletedPath: absolutePath,
        type: stat.isDirectory() ? "directory" : "file",
        backupPath
      }
    };
  }
}
