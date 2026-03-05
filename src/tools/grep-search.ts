import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asBoolean, asNumber, asString, asStringArray } from "../core/json-utils";
import { escapeRegExp, globToRegExp, looksLikeTextFile } from "../core/file-utils";
import { assertInsideWorkspace, resolveSafePath } from "../core/path-utils";

interface GrepHit {
  file: string;
  lineNumber: number;
  lineContent: string;
  before: string[];
  after: string[];
}

interface GitignoreRule {
  negative: boolean;
  matcher: RegExp;
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
        search_path: { type: "string", description: "File or directory path to search (relative to workspace root or absolute)." },
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

    const searchPath = resolveSafePath(searchPathValue, context.workspaceRoot, "search_path");
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
    const gitignoreRules = stat.isDirectory() ? await loadGitignoreRules(searchPath) : [];
    if (stat.isFile()) {
      const fileHits = await this.searchFile(searchPath, regex, contextLines, maxResults);
      hits.push(...fileHits);
    } else if (stat.isDirectory()) {
      await this.searchDirectory(
        searchPath,
        searchPath,
        regex,
        includeMatchers,
        contextLines,
        hits,
        maxResults,
        gitignoreRules
      );
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
    maxResults: number,
    gitignoreRules: GitignoreRule[]
  ): Promise<void> {
    if (hits.length >= maxResults) {
      return;
    }

    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    const files: string[] = [];
    const subdirs: string[] = [];

    for (const entry of entries) {
      if (hits.length >= maxResults) {
        return;
      }

      if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = path.relative(rootPath, absolutePath).replace(/\\/g, "/");
      if (shouldIgnoreByGitignore(relativePath, entry.isDirectory(), gitignoreRules)) {
        continue;
      }

      if (entry.isDirectory()) {
        subdirs.push(absolutePath);
        continue;
      }

      if (!looksLikeTextFile(entry.name)) {
        continue;
      }

      if (includeMatchers.length > 0 && !includeMatchers.some((matcher) => matcher.test(entry.name) || matcher.test(relativePath))) {
        continue;
      }

      files.push(absolutePath);
    }

    const batchSize = 10;
    for (let i = 0; i < files.length; i += batchSize) {
      if (hits.length >= maxResults) {
        return;
      }
      const remaining = maxResults - hits.length;
      const batch = files.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map((absolutePath) => this.searchFile(absolutePath, regex, contextLines, remaining))
      );
      for (const result of batchResults) {
        for (const hit of result) {
          if (hits.length >= maxResults) {
            return;
          }
          hits.push(hit);
        }
      }
    }

    for (const subdir of subdirs) {
      if (hits.length >= maxResults) {
        return;
      }
      await this.searchDirectory(rootPath, subdir, regex, includeMatchers, contextLines, hits, maxResults, gitignoreRules);
    }
  }

  private async searchFile(
    absoluteFilePath: string,
    regex: RegExp,
    contextLines: number,
    maxResults: number
  ): Promise<GrepHit[]> {
    const hits: GrepHit[] = [];

    const stat = await fs.stat(absoluteFilePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.size > 2 * 1024 * 1024) {
      return hits;
    }

    const text = await fs.readFile(absoluteFilePath, "utf8").catch(() => null);
    if (text === null) {
      return hits;
    }

    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (hits.length >= maxResults) {
        return hits;
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
    return hits;
  }
}

async function loadGitignoreRules(searchRoot: string): Promise<GitignoreRule[]> {
  const gitignorePath = path.join(searchRoot, ".gitignore");
  const text = await fs.readFile(gitignorePath, "utf8").catch(() => null);
  if (text === null) {
    return [];
  }

  const rules: GitignoreRule[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const negative = trimmed.startsWith("!");
    const rawPattern = negative ? trimmed.slice(1).trim() : trimmed;
    if (!rawPattern) {
      continue;
    }
    rules.push({
      negative,
      matcher: globToRegExp(rawPattern)
    });
  }
  return rules;
}

function shouldIgnoreByGitignore(relativePath: string, isDirectory: boolean, rules: GitignoreRule[]): boolean {
  if (rules.length === 0) {
    return false;
  }
  const normalized = relativePath.replace(/\\/g, "/");
  const candidate = isDirectory ? `${normalized}/` : normalized;
  let ignored = false;
  for (const rule of rules) {
    if (!rule.matcher.test(normalized) && !rule.matcher.test(candidate)) {
      continue;
    }
    ignored = !rule.negative;
  }
  return ignored;
}

function clampInt(value: number, min: number, max: number): number {
  const integer = Math.floor(value);
  return Math.max(min, Math.min(max, integer));
}
