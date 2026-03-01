import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asNumber, asString } from "../core/json-utils";
import { globToRegExp } from "../core/file-utils";
import { assertInsideWorkspace, ensureAbsolutePath, relativeFromWorkspace, toUnixPath } from "../core/path-utils";

interface FindMatch {
  absolutePath: string;
  relativePath: string;
  isDirectory: boolean;
  sizeBytes: number;
}

const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".mycoderagent",
  ".npm-cache",
  "dist",
  "build",
  ".idea",
  ".vscode"
]);

export class FindByNameTool implements Tool {
  readonly definition = {
    name: "find_by_name",
    description: "Recursively find files/directories by glob pattern from an absolute search path.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        search_path: { type: "string", description: "Absolute root directory to search." },
        pattern: { type: "string", description: "Glob-like pattern, e.g. *.ts or *service*" },
        max_results: { type: "number", description: "Maximum number of results (1-200)." },
        max_depth: { type: "number", description: "Maximum recursion depth from root." }
      },
      required: ["search_path", "pattern"],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const searchPathValue = asString(input.search_path);
    const patternValue = asString(input.pattern);
    if (!searchPathValue || !patternValue) {
      return { ok: false, error: "search_path and pattern are required and must be strings." };
    }

    const rootPath = ensureAbsolutePath(searchPathValue, "search_path");
    assertInsideWorkspace(rootPath, context.workspaceRoot);

    const maxResults = clampInt(asNumber(input.max_results) ?? 80, 1, 200);
    const maxDepth = clampInt(asNumber(input.max_depth) ?? 30, 0, 200);
    const matcher = globToRegExp(patternValue);

    const rootStats = await fs.stat(rootPath).catch(() => null);
    if (!rootStats || !rootStats.isDirectory()) {
      return { ok: false, error: `search_path is not a directory: ${rootPath}` };
    }

    const matches: FindMatch[] = [];
    await this.walk(rootPath, rootPath, 0, maxDepth, matcher, maxResults, matches);

    return {
      ok: true,
      data: {
        searchPath: rootPath,
        pattern: patternValue,
        total: matches.length,
        truncated: matches.length >= maxResults,
        matches
      }
    };
  }

  private async walk(
    rootPath: string,
    currentPath: string,
    depth: number,
    maxDepth: number,
    matcher: RegExp,
    maxResults: number,
    matches: FindMatch[]
  ): Promise<void> {
    if (matches.length >= maxResults || depth > maxDepth) {
      return;
    }

    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= maxResults) {
        return;
      }

      if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(currentPath, entry.name);
      const relative = toUnixPath(path.relative(rootPath, absolutePath));

      if (matcher.test(relative) || matcher.test(entry.name)) {
        const stats = await fs.stat(absolutePath);
        matches.push({
          absolutePath,
          relativePath: relativeFromWorkspace(absolutePath, rootPath),
          isDirectory: stats.isDirectory(),
          sizeBytes: stats.isDirectory() ? 0 : stats.size
        });
      }

      if (entry.isDirectory()) {
        await this.walk(rootPath, absolutePath, depth + 1, maxDepth, matcher, maxResults, matches);
      }
    }
  }
}

function clampInt(value: number, min: number, max: number): number {
  const integer = Math.floor(value);
  return Math.max(min, Math.min(max, integer));
}
