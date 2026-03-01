import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asBoolean, asString } from "../core/json-utils";
import { assertInsideWorkspace, ensureAbsolutePath } from "../core/path-utils";

export class ListDirTool implements Tool {
  readonly definition = {
    name: "list_dir",
    description: "List directory entries as a compact text list. Supports optional recursive tree output.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute directory path."
        },
        recursive: {
          type: "boolean",
          description: "Whether to recursively list nested entries."
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

    const recursive = asBoolean(input.recursive) ?? false;
    const stats = await fs.stat(absolutePath).catch(() => null);
    if (!stats || !stats.isDirectory()) {
      const parentHint = await buildMissingDirHint(absolutePath, context.workspaceRoot);
      return { ok: false, error: parentHint ?? `Directory not found: ${absolutePath}` };
    }

    const lines = recursive
      ? await listRecursiveLines(absolutePath)
      : await listSingleLevelLines(absolutePath);

    return {
      ok: true,
      data: lines.join("\n")
    };
  }
}

async function listSingleLevelLines(absolutePath: string): Promise<string[]> {
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  return entries
    .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
}

async function listRecursiveLines(absolutePath: string): Promise<string[]> {
  const lines: string[] = [];
  await walkDir(absolutePath, "", lines);
  return lines;
}

async function walkDir(absolutePath: string, prefix: string, lines: string[]): Promise<void> {
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  const sorted = entries.sort(
    (left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name)
  );
  for (const entry of sorted) {
    const relativeName = `${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`;
    lines.push(relativeName);
    if (entry.isDirectory()) {
      await walkDir(path.join(absolutePath, entry.name), `${prefix}${entry.name}/`, lines);
    }
  }
}

async function buildMissingDirHint(absolutePath: string, workspaceRoot: string): Promise<string | null> {
  const parentPath = path.dirname(absolutePath);
  if (parentPath === absolutePath) {
    return null;
  }
  if (!isInsideWorkspace(parentPath, workspaceRoot)) {
    return `Directory not found: ${absolutePath}`;
  }
  const parentStat = await fs.stat(parentPath).catch(() => null);
  if (!parentStat || !parentStat.isDirectory()) {
    return `Directory not found: ${absolutePath}`;
  }
  const parentEntries = await fs.readdir(parentPath, { withFileTypes: true });
  const preview = parentEntries
    .slice(0, 30)
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
    .join(", ");
  return `Directory not found: ${absolutePath}. Parent directory exists: ${parentPath}. Available entries: [${preview}]`;
}

function isInsideWorkspace(candidate: string, workspaceRoot: string): boolean {
  const normalizedCandidate = path.resolve(candidate).toLowerCase();
  const normalizedRoot = path.resolve(workspaceRoot).toLowerCase();
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}
