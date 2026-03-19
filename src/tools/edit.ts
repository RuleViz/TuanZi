import { promises as fs } from "node:fs";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asNumber, asString } from "../core/json-utils";
import { assertInsideWorkspace, resolveSafePath } from "../core/path-utils";
import { atomicWriteTextFile } from "../core/file-utils";
import { createLineDiffPreview } from "../core/diff-preview";

interface DiffOperation {
  type: "context" | "remove" | "add";
  content: string;
}

interface DiffHunk {
  originalStart: number;
  originalCount: number;
  newStart: number;
  newCount: number;
  operations: DiffOperation[];
}

export class DiffApplyTool implements Tool {
  readonly definition = {
    name: "edit",
    description: "Apply a unified diff patch to a file. Supports multiple hunks for non-contiguous edits.",
    destructive: true,
    parameters: {
      type: "object",
      properties: {
        targetFile: { type: "string", description: "Target file path (relative to workspace root or absolute)." },
        diff: { type: "string", description: "Unified diff content." },
        fuzz: { type: "number", description: "Optional fuzzy line matching distance (0-5)." }
      },
      required: ["targetFile", "diff"],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const targetFileValue = asString(input.targetFile);
    const diffText = asString(input.diff);
    if (!targetFileValue || !diffText) {
      return { ok: false, error: "targetFile and diff are required and must be strings." };
    }

    const targetFile = resolveSafePath(targetFileValue, context.workspaceRoot, "targetFile");
    assertInsideWorkspace(targetFile, context.workspaceRoot);

    const originalContent = await fs.readFile(targetFile, "utf8").catch(() => null);
    if (originalContent === null) {
      return { ok: false, error: `File not found or unreadable: ${targetFile}` };
    }

    const hunks = parseUnifiedDiff(diffText);
    if (hunks.length === 0) {
      return { ok: false, error: "No valid unified diff hunks found." };
    }

    const fuzz = clampInt(asNumber(input.fuzz) ?? 2, 0, 5);
    const lines = splitPreserveEmptyLastLine(originalContent);
    const sortedHunks = [...hunks].sort((left, right) => right.originalStart - left.originalStart);

    for (const hunk of sortedHunks) {
      const match = findHunkPosition(lines, hunk, fuzz);
      if (!match.found) {
        return {
          ok: false,
          error: `Hunk failed to match near original line ${hunk.originalStart}. Try increasing fuzz or refresh file context first.`
        };
      }
      applyHunk(lines, hunk, match.offset);
    }

    const newContent = joinPreserveEmptyLastLine(lines);
    if (newContent === originalContent) {
      return {
        ok: true,
        data: {
          path: targetFile,
          hunksApplied: hunks.length,
          linesChanged: countChangedLines(hunks),
          message: "Diff applied with no resulting content change."
        }
      };
    }

    const preview = createLineDiffPreview(originalContent, newContent);
    const policyDecision = context.policyEngine?.evaluateTool(this.definition.name, input) ?? {
      decision: "ask" as const,
      reason: "No policy engine configured."
    };
    if (policyDecision.decision === "deny") {
      return { ok: false, error: `Policy denied edit: ${policyDecision.reason}` };
    }
    if (policyDecision.decision === "ask") {
      const approval = await context.approvalGate.approve({
        action: `edit => ${targetFile}`,
        risk: "medium",
        preview
      });
      if (!approval.approved) {
        return { ok: false, error: approval.reason ?? "Patch application rejected." };
      }
    }

    await context.backupManager.backupFile(targetFile);
    await atomicWriteTextFile(targetFile, newContent);

    return {
      ok: true,
      data: {
        path: targetFile,
        hunksApplied: hunks.length,
        linesChanged: countChangedLines(hunks)
      }
    };
  }
}

function parseUnifiedDiff(diffText: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diffText.split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("---") || line.startsWith("+++")) {
      index += 1;
      continue;
    }

    const header = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (!header) {
      index += 1;
      continue;
    }

    const hunk: DiffHunk = {
      originalStart: Number.parseInt(header[1], 10),
      originalCount: Number.parseInt(header[2] ?? "1", 10),
      newStart: Number.parseInt(header[3], 10),
      newCount: Number.parseInt(header[4] ?? "1", 10),
      operations: []
    };
    index += 1;

    while (index < lines.length && !lines[index].startsWith("@@")) {
      const bodyLine = lines[index];
      if (bodyLine.startsWith(" ")) {
        hunk.operations.push({ type: "context", content: bodyLine.slice(1) });
      } else if (bodyLine.startsWith("-")) {
        hunk.operations.push({ type: "remove", content: bodyLine.slice(1) });
      } else if (bodyLine.startsWith("+")) {
        hunk.operations.push({ type: "add", content: bodyLine.slice(1) });
      } else if (bodyLine === "\\ No newline at end of file") {
        // ignore marker line
      } else {
        break;
      }
      index += 1;
    }

    hunks.push(hunk);
  }

  return hunks;
}

function findHunkPosition(fileLines: string[], hunk: DiffHunk, fuzz: number): { found: boolean; offset: number } {
  const expectedLines = hunk.operations
    .filter((operation) => operation.type === "context" || operation.type === "remove")
    .map((operation) => operation.content);

  const exactStart = hunk.originalStart - 1;
  if (matchesAt(fileLines, expectedLines, exactStart)) {
    return { found: true, offset: 0 };
  }

  for (let delta = 1; delta <= fuzz; delta += 1) {
    if (matchesAt(fileLines, expectedLines, exactStart - delta)) {
      return { found: true, offset: -delta };
    }
    if (matchesAt(fileLines, expectedLines, exactStart + delta)) {
      return { found: true, offset: delta };
    }
  }

  return { found: false, offset: 0 };
}

function matchesAt(fileLines: string[], expectedLines: string[], startIndex: number): boolean {
  if (expectedLines.length === 0) {
    return startIndex >= 0 && startIndex <= fileLines.length;
  }
  if (startIndex < 0 || startIndex + expectedLines.length > fileLines.length) {
    return false;
  }
  for (let i = 0; i < expectedLines.length; i += 1) {
    if (fileLines[startIndex + i] !== expectedLines[i]) {
      return false;
    }
  }
  return true;
}

function applyHunk(fileLines: string[], hunk: DiffHunk, offset: number): void {
  const start = hunk.originalStart - 1 + offset;
  const expectedLength = hunk.operations.filter((operation) => operation.type !== "add").length;
  const replacement = hunk.operations
    .filter((operation) => operation.type !== "remove")
    .map((operation) => operation.content);
  fileLines.splice(start, expectedLength, ...replacement);
}

function countChangedLines(hunks: DiffHunk[]): number {
  let count = 0;
  for (const hunk of hunks) {
    for (const operation of hunk.operations) {
      if (operation.type === "add" || operation.type === "remove") {
        count += 1;
      }
    }
  }
  return count;
}

function splitPreserveEmptyLastLine(content: string): string[] {
  if (content.length === 0) {
    return [""];
  }
  return content.split("\n");
}

function joinPreserveEmptyLastLine(lines: string[]): string {
  if (lines.length === 1 && lines[0] === "") {
    return "";
  }
  return lines.join("\n");
}

function clampInt(value: number, min: number, max: number): number {
  const integer = Math.floor(value);
  return Math.max(min, Math.min(max, integer));
}
