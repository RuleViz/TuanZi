import { promises as fs } from "node:fs";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asString } from "../core/json-utils";
import { assertInsideWorkspace, ensureAbsolutePath } from "../core/path-utils";
import { atomicWriteTextFile } from "../core/file-utils";
import { createLineDiffPreview } from "../core/diff-preview";

export class ReplaceFileContentTool implements Tool {
  readonly definition = {
    name: "replace_file_content",
    description:
      "Replace a unique target content block in a file. Fails when target is missing or appears multiple times.",
    destructive: true,
    parameters: {
      type: "object",
      properties: {
        targetFile: { type: "string", description: "Absolute path of target file." },
        targetContent: { type: "string", description: "Exact old content block to replace." },
        replacementContent: { type: "string", description: "New content block." }
      },
      required: ["targetFile", "targetContent", "replacementContent"],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const targetFileValue = asString(input.targetFile);
    const targetContent = asString(input.targetContent);
    const replacementContent = asString(input.replacementContent);

    if (!targetFileValue || targetContent === null || replacementContent === null) {
      return {
        ok: false,
        error: "targetFile, targetContent, replacementContent are required and must be strings."
      };
    }

    const targetFile = ensureAbsolutePath(targetFileValue, "targetFile");
    assertInsideWorkspace(targetFile, context.workspaceRoot);

    const currentContent = await fs.readFile(targetFile, "utf8").catch(() => null);
    if (currentContent === null) {
      return { ok: false, error: `Target file does not exist or cannot be read: ${targetFile}` };
    }

    const matchCount = countOccurrences(currentContent, targetContent);
    if (matchCount !== 1) {
      return {
        ok: false,
        error:
          matchCount === 0
            ? "targetContent was not found. Please provide a more accurate snippet."
            : `targetContent is not unique (${matchCount} matches). Please provide more surrounding context.`
      };
    }

    const nextContent = currentContent.replace(targetContent, replacementContent);
    const preview = createLineDiffPreview(currentContent, nextContent);
    const policyDecision = context.policyEngine?.evaluateTool(this.definition.name, input) ?? {
      decision: "ask" as const,
      reason: "No policy engine configured."
    };
    if (policyDecision.decision === "deny") {
      return { ok: false, error: `Policy denied replace_file_content: ${policyDecision.reason}` };
    }
    if (policyDecision.decision === "ask") {
      const approval = await context.approvalGate.approve({
        action: `replace_file_content => ${targetFile}`,
        risk: "medium",
        preview
      });
      if (!approval.approved) {
        return { ok: false, error: approval.reason ?? "Replacement rejected." };
      }
    }

    const backupPath = await context.backupManager.backupFile(targetFile);
    await atomicWriteTextFile(targetFile, nextContent);

    return {
      ok: true,
      data: {
        targetFile,
        matchCount,
        backupPath
      }
    };
  }
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let index = 0;
  while (true) {
    const found = text.indexOf(needle, index);
    if (found < 0) {
      break;
    }
    count += 1;
    index = found + needle.length;
  }
  return count;
}
