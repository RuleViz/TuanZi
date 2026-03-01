import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asBoolean, asNumber, asString, asStringArray } from "../core/json-utils";
import { escapeRegExp, globToRegExp, looksLikeTextFile } from "../core/file-utils";
import { assertInsideWorkspace, ensureAbsolutePath } from "../core/path-utils";

interface GrepHit {
  file: string;
  lineNumber: number;
  lineContent: string;
  before: string[];
  after: string[];
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

export class GrepSearchTool implements Tool {
  readonly definition = {
    name: "grep_search",
    description:
      "Search file content by plain text or regex. Returns matches with line number and around-3-line context.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        search_path: { type: "string", description: "Absolute file or directory path to search." },
        query: { type: "string", description: "Plain text or regex pattern." },
        is_regex: { type: "boolean", description: "Whether query should be treated as regex." },
        case_sensitive: { type: "boolean", description: "Whether match should be case-sensitive." },
        includes: {
          type: "array",
          items: { type: "string" },
          description: "Optional glob filters, e.g. ['*.ts', '*.md']."
        },
        max_results: { type: "number", description: "Max returned hits (1-200)." },
        context_lines: { type: "number", description: "Surrounding lines for each hit (0-10)." }
      },
      required: ["search_path", "query"],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const searchPathValue = asString(input.search_path);
    const queryValue = asString(input.query);
    if (!searchPathValue || !queryValue) {
      return { ok: false, error: "search_path and query are required and must be strings." };
    }

    const searchPath = ensureAbsolutePath(searchPathValue, "search_path");
    assertInsideWorkspace(searchPath, context.workspaceRoot);

    const maxResults = clampInt(asNumber(input.max_results) ?? 100, 1, 200);
    const contextLines = clampInt(asNumber(input.context_lines) ?? 3, 0, 10);
    const isRegex = asBoolean(input.is_regex) ?? false;
    const caseSensitive = asBoolean(input.case_sensitive) ?? false;
    const includes = asStringArray(input.includes) ?? [];
    const includeMatchers = includes.map((pattern) => globToRegExp(pattern));

    const pattern = isRegex ? queryValue : escapeRegExp(queryValue);
    const flags = caseSensitive ? "" : "i";
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Invalid regex: ${message}` };
    }

    const stat = await fs.stat(searchPath).catch(() => null);
    if (!stat) {
      return { ok: false, error: `search_path does not exist: ${searchPath}` };
    }

    const hits: GrepHit[] = [];
    if (stat.isFile()) {
      await this.searchFile(searchPath, regex, contextLines, hits, maxResults);
    } else if (stat.isDirectory()) {
      await this.searchDirectory(searchPath, searchPath, regex, includeMatchers, contextLines, hits, maxResults);
    } else {
      return { ok: false, error: "Unsupported search_path type." };
    }

    return {
      ok: true,
      data: {
        query: queryValue,
        total: hits.length,
        truncated: hits.length >= maxResults,
        hits
      }
    };
  }

  private async searchDirectory(
    rootPath: string,
    currentPath: string,
    regex: RegExp,
    includeMatchers: RegExp[],
    contextLines: number,
    hits: GrepHit[],
    maxResults: number
  ): Promise<void> {
    if (hits.length >= maxResults) {
      return;
    }

    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (hits.length >= maxResults) {
        return;
      }

      if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await this.searchDirectory(rootPath, absolutePath, regex, includeMatchers, contextLines, hits, maxResults);
        continue;
      }

      if (!looksLikeTextFile(entry.name)) {
        continue;
      }

      const relativePath = path.relative(rootPath, absolutePath).replace(/\\/g, "/");
      if (includeMatchers.length > 0 && !includeMatchers.some((matcher) => matcher.test(entry.name) || matcher.test(relativePath))) {
        continue;
      }

      await this.searchFile(absolutePath, regex, contextLines, hits, maxResults);
    }
  }

  private async searchFile(
    absoluteFilePath: string,
    regex: RegExp,
    contextLines: number,
    hits: GrepHit[],
    maxResults: number
  ): Promise<void> {
    if (hits.length >= maxResults) {
      return;
    }

    const stat = await fs.stat(absoluteFilePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.size > 2 * 1024 * 1024) {
      return;
    }

    const text = await fs.readFile(absoluteFilePath, "utf8").catch(() => null);
    if (text === null) {
      return;
    }

    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (hits.length >= maxResults) {
        return;
      }

      const line = lines[index];
      regex.lastIndex = 0;
      if (!regex.test(line)) {
        continue;
      }

      const from = Math.max(0, index - contextLines);
      const to = Math.min(lines.length - 1, index + contextLines);
      const before = lines.slice(from, index);
      const after = lines.slice(index + 1, to + 1);
      hits.push({
        file: absoluteFilePath,
        lineNumber: index + 1,
        lineContent: line,
        before,
        after
      });
    }
  }
}

function clampInt(value: number, min: number, max: number): number {
  const integer = Math.floor(value);
  return Math.max(min, Math.min(max, integer));
}
