import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asBoolean, asNumber, asString } from "../core/json-utils";
import { globToRegExp } from "../core/file-utils";
import { assertInsideWorkspace, resolveSafePath } from "../core/path-utils";

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 2000;

export class ListDirTool implements Tool {
  readonly definition = {
    name: "ls",
    description: "List direct entries in a directory (non-recursive).",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path (relative to workspace root or absolute)."
        },
        limit: {
          type: "number",
          description: "Maximum number of entries to return (default 2000, hard max 2000)."
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
    throwIfAborted(context.signal);
    if (input.recursive !== undefined || input.max_depth !== undefined) {
      return {
        ok: false,
        error: "ls no longer supports recursive/max_depth. Use glob for deep traversal."
      };
    }
    const pathValue = asString(input.path);
    if (!pathValue) {
      return { ok: false, error: "path is required and must be a string." };
    }

    const absolutePath = resolveSafePath(pathValue, context.workspaceRoot);
    assertInsideWorkspace(absolutePath, context.workspaceRoot);

    const limit = clampInt(asNumber(input.limit) ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const showHidden = asBoolean(input.show_hidden) ?? false;
    const pattern = asString(input.pattern);
    const matcher = pattern ? globToRegExp(pattern) : null;

    throwIfAborted(context.signal);
    const stats = await fs.stat(absolutePath).catch(() => null);
    if (!stats || !stats.isDirectory()) {
      const parentHint = await buildMissingDirHint(absolutePath, context.workspaceRoot);
      return { ok: false, error: parentHint ?? `Directory not found: ${absolutePath}` };
    }

    const listing = await listOneLevel(absolutePath, {
      limit,
      showHidden,
      matcher
    }, context.signal);
    throwIfAborted(context.signal);

    const lines = listing.entries.map((entry) => `${entry.path}${entry.isDirectory ? "/" : ""}`);
    if (listing.truncated) {
      lines.push(`... output truncated: returned first ${limit} entries. Narrow with pattern or path.`);
    }

    const entries = listing.entries.map((entry) => ({
      path: `${entry.path}${entry.isDirectory ? "/" : ""}`,
      isDirectory: entry.isDirectory,
      depth: 1
    }));

    return {
      ok: true,
      data: {
        content: lines.join("\n"),
        total: entries.length,
        truncated: listing.truncated,
        entries
      }
    };
  }
}

async function listOneLevel(
  absolutePath: string,
  options: {
    limit: number;
    showHidden: boolean;
    matcher: RegExp | null;
  },
  signal?: AbortSignal
): Promise<{ entries: Array<{ path: string; isDirectory: boolean }>; truncated: boolean }> {
  const output: Array<{ path: string; isDirectory: boolean }> = [];
  let truncated = false;
  const dir = await fs.opendir(absolutePath);
  try {
    for await (const entry of dir) {
      throwIfAborted(signal);

      if (!options.showHidden && entry.name.startsWith(".")) {
        continue;
      }

      const normalizedName = entry.name.replace(/\\/g, "/");
      const normalizedWithSuffix = entry.isDirectory() ? `${normalizedName}/` : normalizedName;
      const include =
        !options.matcher ||
        options.matcher.test(normalizedName) ||
        options.matcher.test(normalizedWithSuffix);

      if (!include) {
        continue;
      }

      if (output.length >= options.limit) {
        truncated = true;
        break;
      }

      output.push({
        path: normalizedName,
        isDirectory: entry.isDirectory()
      });
    }
  } finally {
    await dir.close().catch(() => null);
  }

  output.sort((left, right) => Number(right.isDirectory) - Number(left.isDirectory) || left.path.localeCompare(right.path));
  return {
    entries: output,
    truncated
  };
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Interrupted by user");
  }
}

function clampInt(value: number, min: number, max: number): number {
  const integer = Math.floor(value);
  return Math.max(min, Math.min(max, integer));
}
