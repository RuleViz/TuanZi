import { promises as fs } from "node:fs";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asString } from "../core/json-utils";
import { assertInsideWorkspace, resolveSafePath } from "../core/path-utils";
import { atomicWriteTextFile } from "../core/file-utils";
import { createLineDiffPreview } from "../core/diff-preview";

export class WriteToFileTool implements Tool {
  readonly definition = {
    name: "write_to_file",
    description: "Write full file content to a path. Creates parent directories automatically.",
    destructive: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write (relative to workspace root or absolute)." },
        content: { type: "string", description: "Full content to overwrite with." }
      },
      required: ["path", "content"],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const pathValue = asString(input.path);
    const content = asString(input.content);

    if (!pathValue || content === null) {
      return { ok: false, error: "path and content are required and must be strings." };
    }

    const absolutePath = resolveSafePath(pathValue, context.workspaceRoot);
    assertInsideWorkspace(absolutePath, context.workspaceRoot);

    const previousContent = await fs.readFile(absolutePath, "utf8").catch(() => "");
    const preview = previousContent
      ? createLineDiffPreview(previousContent, content)
      : "New file will be created.";

    const policyDecision = context.policyEngine?.evaluateTool(this.definition.name, input) ?? {
      decision: "ask" as const,
      reason: "No policy engine configured."
    };
    if (policyDecision.decision === "deny") {
      return { ok: false, error: `Policy denied write_to_file: ${policyDecision.reason}` };
    }
    if (policyDecision.decision === "ask") {
      const approval = await context.approvalGate.approve({
        action: `write_to_file => ${absolutePath}`,
        risk: previousContent ? "medium" : "low",
        preview
      });
      if (!approval.approved) {
        return { ok: false, error: approval.reason ?? "Write rejected." };
      }
    }

    const backupPath = previousContent ? await context.backupManager.backupFile(absolutePath) : null;
    await atomicWriteTextFile(absolutePath, content);

    return {
      ok: true,
      data: {
        path: absolutePath,
        bytesWritten: Buffer.byteLength(content, "utf8"),
        backupPath
      }
    };
  }
}
