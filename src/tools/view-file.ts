import { promises as fs } from "node:fs";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asNumber, asString } from "../core/json-utils";
import { assertInsideWorkspace, ensureAbsolutePath } from "../core/path-utils";

const DEFAULT_WINDOW_SIZE = 800;

export class ViewFileTool implements Tool {
  readonly definition = {
    name: "view_file",
    description:
      "Read a file with line numbers. Supports start_line/end_line for pagination and returns '<line>: <content>' format.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path." },
        start_line: { type: "number", description: "1-indexed start line (inclusive)." },
        end_line: { type: "number", description: "1-indexed end line (inclusive)." }
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
    if (!stat || !stat.isFile()) {
      return { ok: false, error: `File not found: ${absolutePath}` };
    }

    const startLine = Math.max(1, Math.floor(asNumber(input.start_line) ?? 1));
    const requestedEnd = asNumber(input.end_line);
    const defaultEnd = startLine + DEFAULT_WINDOW_SIZE - 1;
    const endLine = Math.max(startLine, Math.floor(requestedEnd ?? defaultEnd));

    const content = await fs.readFile(absolutePath, "utf8");
    const lines = content.split(/\r?\n/);
    const safeEndLine = Math.min(endLine, lines.length || 1);
    const selectedLines = lines.slice(startLine - 1, safeEndLine);
    const formattedLines = selectedLines.map((line, index) => `${startLine + index}: ${line}`);

    return {
      ok: true,
      data: {
        path: absolutePath,
        totalLines: lines.length,
        startLine,
        endLine: safeEndLine,
        content: formattedLines.join("\n")
      }
    };
  }
}
