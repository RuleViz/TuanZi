import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asBoolean, asNumber, asString } from "../core/json-utils";
import { globToRegExp } from "../core/file-utils";
import { assertInsideWorkspace, resolveSafePath } from "../core/path-utils";

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
          description: "Directory path (relative to workspace root or absolute)."
        },
        recursive: {
          type: "boolean",
          description: "Whether to recursively list nested entries."
        },
        max_depth: {
          type: "number",
          description: "Maximum recursion depth (default 1). 0 means only current directory."
        },
        show_hidden: {
          type: "boolean",
          description: "Whether to include hidden files/directories."
        },
        pattern: {
          type: "string",
          description: "Optional glob pattern filter, e.g. *.ts"
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

    const absolutePath = resolveSafePath(pathValue, context.workspaceRoot);
    assertInsideWorkspace(absolutePath, context.workspaceRoot);

    const recursive = asBoolean(input.recursive) ?? false;
    const maxDepth = clampInt(asNumber(input.max_depth) ?? (recursive ? 50 : 1), 0, 200);
    const showHidden = asBoolean(input.show_hidden) ?? false;
    const pattern = asString(input.pattern);
    const matcher = pattern ? globToRegExp(pattern) : null;

    const stats = await fs.stat(absolutePath).catch(() => null);
    if (!stats || !stats.isDirectory()) {
      const parentHint = await buildMissingDirHint(absolutePath, context.workspaceRoot);
      return { ok: false, error: parentHint ?? `Directory not found: ${absolutePath}` };
    }

    const entries: Array<{ path: string; isDirectory: boolean; depth: number }> = [];
    const lines = await listTreeLines(absolutePath, {
      maxDepth,
      showHidden,
      matcher,
      entries
    });

    return {
      ok: true,
      data: {
        content: lines.join("\n"),
        total: entries.length,
        entries
      }
    };
  }
}

async function listTreeLines(
  rootPath: string,
  options: {
    maxDepth: number;
    showHidden: boolean;
    matcher: RegExp | null;
    entries: Array<{ path: string; isDirectory: boolean; depth: number }>;
  }
): Promise<string[]> {
  const lines: string[] = [];
  await walkDir(rootPath, "", 0, lines, options);
  return lines;
}

async function walkDir(
  absolutePath: string,
  relativePrefix: string,
  depth: number,
  lines: string[],
  options: {
    maxDepth: number;
    showHidden: boolean;
    matcher: RegExp | null;
    entries: Array<{ path: string; isDirectory: boolean; depth: number }>;
  }
): Promise<void> {
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  const sorted = entries.sort(
    (left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name)
  );
  for (const entry of sorted) {
    if (!options.showHidden && entry.name.startsWith(".")) {
      continue;
    }

    const nextRelative = `${relativePrefix}${entry.name}${entry.isDirectory() ? "/" : ""}`;
    const normalized = nextRelative.replace(/\\/g, "/");
    const entryDepth = depth + 1;
    if (entryDepth > options.maxDepth) {
      continue;
    }
    const include = !options.matcher || options.matcher.test(entry.name) || options.matcher.test(normalized);
    if (include) {
      lines.push(`${"  ".repeat(Math.max(0, entryDepth - 1))}${normalized}`);
      options.entries.push({
        path: normalized,
        isDirectory: entry.isDirectory(),
        depth: entryDepth
      });
    }

    if (entry.isDirectory() && entryDepth < options.maxDepth) {
      await walkDir(path.join(absolutePath, entry.name), `${relativePrefix}${entry.name}/`, entryDepth, lines, options);
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

function clampInt(value: number, min: number, max: number): number {
  const integer = Math.floor(value);
  return Math.max(min, Math.min(max, integer));
}
