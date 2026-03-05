import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asNumber, asString, asStringArray } from "../core/json-utils";
import { looksLikeTextFile } from "../core/file-utils";
import { assertInsideWorkspace, resolveSafePath } from "../core/path-utils";

type CodeSymbolType = "function" | "class" | "interface" | "type" | "variable" | "export" | "import";

interface CodeSymbol {
  name: string;
  type: CodeSymbolType;
  file: string;
  line: number;
  signature: string;
  context: string[];
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

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

const SYMBOL_PATTERNS: Array<{ type: CodeSymbolType; pattern: RegExp; nameGroup: number }> = [
  { type: "function", pattern: /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)/, nameGroup: 1 },
  {
    type: "function",
    pattern: /^\s*(?:public|private|protected|static|readonly|async|\s)*([A-Za-z_]\w*)\s*\([^)]*\)\s*[:{]/,
    nameGroup: 1
  },
  { type: "class", pattern: /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_]\w*)/, nameGroup: 1 },
  { type: "interface", pattern: /^(?:export\s+)?interface\s+([A-Za-z_]\w*)/, nameGroup: 1 },
  { type: "type", pattern: /^(?:export\s+)?type\s+([A-Za-z_]\w*)\s*[=<]/, nameGroup: 1 },
  { type: "variable", pattern: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*[:=]/, nameGroup: 1 },
  {
    type: "export",
    pattern: /^export\s+(?:default\s+)?(?:function|class|const|let|var)\s+([A-Za-z_]\w*)/,
    nameGroup: 1
  },
  { type: "import", pattern: /^import\s+(?:type\s+)?(?:.+?\s+from\s+)?["'][^"']+["']/, nameGroup: 0 },
  { type: "function", pattern: /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, nameGroup: 1 },
  { type: "class", pattern: /^class\s+([A-Za-z_]\w*)/, nameGroup: 1 },
  { type: "function", pattern: /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)\s*\(/, nameGroup: 1 },
  { type: "type", pattern: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, nameGroup: 1 }
];

const VALID_SYMBOL_TYPES = new Set<CodeSymbolType>(["function", "class", "interface", "type", "variable", "export", "import"]);

export class CodebaseSearchTool implements Tool {
  readonly definition = {
    name: "codebase_search",
    description:
      "Search code symbols (function/class/interface/type/export/import) across workspace with file, line and context.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol name or signature keyword." },
        symbol_types: {
          type: "array",
          items: { type: "string" },
          description: "Optional symbol type filters."
        },
        scope: { type: "string", description: "Optional scope path (relative to workspace root or absolute)." },
        max_results: { type: "number", description: "Maximum matches to return (1-100)." }
      },
      required: ["query"],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const query = asString(input.query);
    if (!query) {
      return { ok: false, error: "query is required and must be a string." };
    }

    const maxResults = clampInt(asNumber(input.max_results) ?? 30, 1, 100);
    const scope = asString(input.scope) ?? "";
    const searchRoot = resolveScope(scope, context.workspaceRoot);
    assertInsideWorkspace(searchRoot, context.workspaceRoot);

    const rootStat = await fs.stat(searchRoot).catch(() => null);
    if (!rootStat || !rootStat.isDirectory()) {
      return { ok: false, error: `scope is not a directory: ${searchRoot}` };
    }

    const requestedTypes = (asStringArray(input.symbol_types) ?? [])
      .map((item) => item.toLowerCase())
      .filter((item): item is CodeSymbolType => VALID_SYMBOL_TYPES.has(item as CodeSymbolType));
    const typeFilter = new Set<CodeSymbolType>(requestedTypes);
    const candidateLimit = Math.max(maxResults * 5, 50);

    const symbols: CodeSymbol[] = [];
    await scanDirectory(searchRoot, symbols, candidateLimit);

    const queryLower = query.toLowerCase();
    const matched = symbols
      .filter((symbol) => {
        if (typeFilter.size > 0 && !typeFilter.has(symbol.type)) {
          return false;
        }
        return (
          symbol.name.toLowerCase().includes(queryLower) || symbol.signature.toLowerCase().includes(queryLower)
        );
      })
      .sort((left, right) => compareSymbolRank(left, right, queryLower))
      .slice(0, maxResults);

    return {
      ok: true,
      data: {
        query,
        total: matched.length,
        symbols: matched
      }
    };
  }
}

async function scanDirectory(rootPath: string, symbols: CodeSymbol[], candidateLimit: number): Promise<void> {
  if (symbols.length >= candidateLimit) {
    return;
  }

  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (symbols.length >= candidateLimit) {
      return;
    }

    if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(absolutePath, symbols, candidateLimit);
      continue;
    }

    if (!entry.isFile() || !looksLikeTextFile(entry.name)) {
      continue;
    }

    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.size > MAX_FILE_SIZE_BYTES) {
      continue;
    }

    const content = await fs.readFile(absolutePath, "utf8").catch(() => null);
    if (content === null) {
      continue;
    }
    collectSymbolsFromFile(content, absolutePath, symbols, candidateLimit);
  }
}

function collectSymbolsFromFile(content: string, absoluteFilePath: string, symbols: CodeSymbol[], candidateLimit: number): void {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (symbols.length >= candidateLimit) {
      return;
    }
    const line = lines[index];
    for (const descriptor of SYMBOL_PATTERNS) {
      const match = line.match(descriptor.pattern);
      if (!match) {
        continue;
      }
      const name = descriptor.nameGroup === 0 ? line.trim() : match[descriptor.nameGroup];
      if (!name) {
        continue;
      }
      symbols.push({
        name,
        type: descriptor.type,
        file: absoluteFilePath,
        line: index + 1,
        signature: line.trim(),
        context: lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 3))
      });
      break;
    }
  }
}

function resolveScope(scope: string, workspaceRoot: string): string {
  if (!scope) {
    return workspaceRoot;
  }
  return resolveSafePath(scope, workspaceRoot, "scope");
}

function compareSymbolRank(left: CodeSymbol, right: CodeSymbol, queryLower: string): number {
  const leftName = left.name.toLowerCase();
  const rightName = right.name.toLowerCase();
  const leftExact = leftName === queryLower ? 0 : 1;
  const rightExact = rightName === queryLower ? 0 : 1;
  if (leftExact !== rightExact) {
    return leftExact - rightExact;
  }

  const leftPrefix = leftName.startsWith(queryLower) ? 0 : 1;
  const rightPrefix = rightName.startsWith(queryLower) ? 0 : 1;
  if (leftPrefix !== rightPrefix) {
    return leftPrefix - rightPrefix;
  }

  if (left.file !== right.file) {
    return left.file.localeCompare(right.file);
  }
  return left.line - right.line;
}

function clampInt(value: number, min: number, max: number): number {
  const integer = Math.floor(value);
  return Math.max(min, Math.min(max, integer));
}
