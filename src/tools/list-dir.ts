import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asString } from "../core/json-utils";
import { assertInsideWorkspace, ensureAbsolutePath } from "../core/path-utils";

export class ListDirTool implements Tool {
  readonly definition = {
    name: "list_dir",
    description: "List one-level children of an absolute directory path.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute directory path."
        }
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

    const stats = await fs.stat(absolutePath).catch(() => null);
    if (!stats || !stats.isDirectory()) {
      return { ok: false, error: `Directory not found: ${absolutePath}` };
    }

    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const results = await Promise.all(
      entries.map(async (entry) => {
        const childPath = path.join(absolutePath, entry.name);
        const childStats = await fs.stat(childPath);
        return {
          name: entry.name,
          absolutePath: childPath,
          isDirectory: childStats.isDirectory(),
          sizeBytes: childStats.isDirectory() ? 0 : childStats.size,
          modifiedAt: childStats.mtime.toISOString()
        };
      })
    );

    return {
      ok: true,
      data: {
        path: absolutePath,
        totalEntries: results.length,
        entries: results.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
      }
    };
  }
}
