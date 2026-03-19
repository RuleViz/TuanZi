import { promises as fs } from "node:fs";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asNumber, asString } from "../core/json-utils";
import { assertInsideWorkspace, resolveSafePath } from "../core/path-utils";

const DEFAULT_LIMIT = 800;
const MAX_LIMIT = 2000;

export class ViewFileTool implements Tool {
  readonly definition = {
    name: "read",
    description: "Read a single file with line numbers and pagination (offset/limit).",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative to workspace root or absolute)." },
        offset: { type: "number", description: "0-indexed line offset." },
        limit: { type: "number", description: "Maximum number of lines (default 800, hard max 2000)." }
      },
      required: ["path"],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    throwIfAborted(context.signal);
    if (input.paths !== undefined || input.start_line !== undefined || input.end_line !== undefined) {
      return {
        ok: false,
        error: "read no longer supports paths/start_line/end_line. Use path + offset + limit."
      };
    }
    const pathValue = asString(input.path);
    if (!pathValue) {
      return { ok: false, error: "path is required and must be a string." };
    }

    const absolutePath = resolveSafePath(pathValue, context.workspaceRoot);
    assertInsideWorkspace(absolutePath, context.workspaceRoot);

    const offset = Math.max(0, Math.floor(asNumber(input.offset) ?? 0));
    const limit = clampInt(asNumber(input.limit) ?? DEFAULT_LIMIT, 1, MAX_LIMIT);

    throwIfAborted(context.signal);
    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      return { ok: false, error: `File not found: ${absolutePath}` };
    }

    const text = await fs.readFile(absolutePath, { encoding: "utf8", signal: context.signal });
    throwIfAborted(context.signal);
    const lines = text.split(/\r?\n/);

    const safeOffset = Math.min(offset, lines.length);
    const endExclusive = Math.min(safeOffset + limit, lines.length);
    const selected = lines.slice(safeOffset, endExclusive);
    const contentLines = selected.map((line, index) => `${safeOffset + index + 1}: ${line}`);
    const hasMore = endExclusive < lines.length;
    const nextOffset = hasMore ? endExclusive : null;
    const viewedRange =
      selected.length === 0 ? `${safeOffset + 1}-${safeOffset + 1}` : `${safeOffset + 1}-${endExclusive}`;
    const content = `=== File: ${absolutePath} ===\n${contentLines.join("\n")}`;

    return {
      ok: true,
      data: {
        content,
        file: {
          path: absolutePath,
          content: contentLines.join("\n")
        },
        metadata: {
          totalLines: lines.length,
          fileSize: stat.size,
          offset: safeOffset,
          limit,
          returnedLines: selected.length,
          viewedRange,
          hasMore,
          nextOffset
        }
      }
    };
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Interrupted by user");
  }
}

function clampInt(value: number, min: number, max: number): number {
  const integer = Math.floor(value);
  return Math.max(min, Math.min(max, integer));
}
