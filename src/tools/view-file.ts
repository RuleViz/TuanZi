import { promises as fs } from "node:fs";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asNumber, asString, asStringArray } from "../core/json-utils";
import { assertInsideWorkspace, resolveSafePath } from "../core/path-utils";

const DEFAULT_WINDOW_SIZE = 800;
const MAX_WINDOW_LINES = 2000;

export class ViewFileTool implements Tool {
  readonly definition = {
    name: "view_file",
    description:
      "Read one or multiple files with line numbers. Supports start_line/end_line and returns compact text blocks.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative to workspace root or absolute)." },
        paths: { type: "array", items: { type: "string" }, description: "File paths (relative or absolute)." },
        start_line: { type: "number", description: "1-indexed start line (inclusive)." },
        end_line: { type: "number", description: "1-indexed end line (inclusive)." }
      },
      required: [],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const pathValues = normalizePaths(input);
    if (pathValues.length === 0) {
      return { ok: false, error: "paths is required and must include at least one file path." };
    }

    const startLine = Math.max(1, Math.floor(asNumber(input.start_line) ?? 1));
    const requestedEnd = asNumber(input.end_line);
    const defaultEnd = startLine + DEFAULT_WINDOW_SIZE - 1;
    const endLine = Math.max(startLine, Math.floor(requestedEnd ?? defaultEnd));

    const requestedWindow = endLine - startLine + 1;
    const safeWindow = Math.min(requestedWindow, MAX_WINDOW_LINES);
    const effectiveEndLine = startLine + safeWindow - 1;
    const truncationApplied = safeWindow < requestedWindow;

    const blocks = await Promise.all(
      pathValues.map(async (pathValue) => {
        const absolutePath = resolveSafePath(pathValue, context.workspaceRoot);
        assertInsideWorkspace(absolutePath, context.workspaceRoot);
        const stat = await fs.stat(absolutePath).catch(() => null);
        if (!stat || !stat.isFile()) {
          return {
            absolutePath,
            content: "",
            metadata: {
              totalLines: 0,
              fileSize: 0,
              viewedRange: `${startLine}-${startLine}`,
              hasMore: false
            },
            error: "File not found."
          };
        }

        const content = await fs.readFile(absolutePath, "utf8");
        const lines = content.split(/\r?\n/);
        const safeEndLine = Math.min(effectiveEndLine, lines.length || 1);
        const selectedLines = lines.slice(startLine - 1, safeEndLine);
        const formattedLines = selectedLines.map((line, index) => `${startLine + index}: ${line}`);
        return {
          absolutePath,
          content: formattedLines.join("\n"),
          metadata: {
            totalLines: lines.length,
            fileSize: stat.size,
            viewedRange: `${startLine}-${safeEndLine}`,
            hasMore: safeEndLine < lines.length
          }
        };
      })
    );

    const joined = blocks
      .map((block) => {
        const header = `=== File: ${block.absolutePath} ===`;
        if (block.error) {
          return `${header}\n[Error] ${block.error}`;
        }
        return `${header}\n${block.content}`;
      })
      .join("\n\n");
    const truncationHint = truncationApplied
      ? "\n\n... (output truncated for safety; narrow start_line/end_line to continue reading)"
      : "";
    const metadata = blocks.length === 1 ? blocks[0].metadata : undefined;
    return {
      ok: true,
      data: {
        content: `${joined}${truncationHint}`,
        files: blocks.map((block) => ({
          path: block.absolutePath,
          content: block.content,
          metadata: block.metadata,
          error: block.error
        })),
        metadata
      }
    };
  }
}

function normalizePaths(input: JsonObject): string[] {
  const paths = asStringArray(input.paths);
  if (paths && paths.length > 0) {
    return paths;
  }
  const singlePath = asString(input.path);
  return singlePath ? [singlePath] : [];
}
