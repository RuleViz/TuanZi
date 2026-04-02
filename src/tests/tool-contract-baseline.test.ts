/**
 * Contract tests for read / ls / glob / grep tools.
 *
 * These tests capture the exact input→output behaviour that any replacement
 * implementation (including the planned Rust native backend) must reproduce.
 *
 * Run:  npm run build && node --test dist/tests/tool-contract-baseline.test.js
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, describe } from "node:test";
import { ReadTool } from "../tools/read";
import { LsTool } from "../tools/ls";
import { GlobTool } from "../tools/glob";
import { GrepTool } from "../tools/grep";
import type { ToolExecutionContext, ToolExecutionResult } from "../core/types";

/* ---------- helpers ---------- */

function createContext(workspaceRoot: string, signal?: AbortSignal): ToolExecutionContext {
  return {
    workspaceRoot,
    signal,
    approvalGate: { async approve() { return { approved: true }; } },
    backupManager: { async backupFile() { return null; } },
    logger: { info() {}, warn() {}, error() {} }
  } as unknown as ToolExecutionContext;
}

function setupFixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), "tuanzi-contract-"));

  // Create a small but representative file tree:
  // root/
  //   src/
  //     index.ts        (5 lines)
  //     util.ts          (3 lines)
  //     nested/
  //       deep.ts        (2 lines)
  //   docs/
  //     readme.md        (4 lines)
  //   .hidden-file       (1 line)
  //   package.json       (1 line)

  mkdirSync(path.join(root, "src", "nested"), { recursive: true });
  mkdirSync(path.join(root, "docs"), { recursive: true });

  writeFileSync(path.join(root, "src", "index.ts"), [
    'import { hello } from "./util";',
    "",
    "export function main() {",
    '  console.log(hello("world"));',
    "}"
  ].join("\n"), "utf8");

  writeFileSync(path.join(root, "src", "util.ts"), [
    "export function hello(name: string): string {",
    '  return `Hello, ${name}!`;',
    "}"
  ].join("\n"), "utf8");

  writeFileSync(path.join(root, "src", "nested", "deep.ts"), [
    "export const DEEP_VALUE = 42;",
    "export const DEEP_NAME = 'deep';"
  ].join("\n"), "utf8");

  writeFileSync(path.join(root, "docs", "readme.md"), [
    "# Project",
    "",
    "This is a test project.",
    "Nothing else to say."
  ].join("\n"), "utf8");

  writeFileSync(path.join(root, ".hidden-file"), "secret\n", "utf8");
  writeFileSync(path.join(root, "package.json"), '{"name":"fixture"}\n', "utf8");

  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

/* ============================================================
 *  READ TOOL CONTRACT
 * ============================================================ */

describe("read tool contract", () => {
  test("full file read returns correct metadata", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new ReadTool();
      const result = await tool.execute({ path: "src/index.ts" }, createContext(root));
      assert.equal(result.ok, true);

      const data = result.data as Record<string, unknown>;
      const metadata = data.metadata as Record<string, unknown>;

      // Shape checks
      assert.equal(typeof data.content, "string");
      assert.ok(data.file);
      assert.ok(metadata);

      // Metadata contract
      assert.equal(metadata.totalLines, 5);
      assert.equal(typeof metadata.fileSize, "number");
      assert.equal(metadata.offset, 0);
      assert.equal(metadata.limit, null);
      assert.equal(metadata.returnedLines, 5);
      assert.equal(metadata.hasMore, false);
      assert.equal(metadata.nextOffset, null);
      assert.equal(metadata.viewedRange, "1-5");

      // Content should have line numbers
      const content = data.content as string;
      assert.match(content, /1: import/);
      assert.match(content, /5: }/);
    } finally {
      cleanup();
    }
  });

  test("paginated read with offset and limit", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new ReadTool();
      const result = await tool.execute(
        { path: "src/index.ts", offset: 1, limit: 2 },
        createContext(root)
      );
      assert.equal(result.ok, true);

      const data = result.data as Record<string, unknown>;
      const metadata = data.metadata as Record<string, unknown>;

      assert.equal(metadata.offset, 1);
      assert.equal(metadata.limit, 2);
      assert.equal(metadata.returnedLines, 2);
      assert.equal(metadata.hasMore, true);
      assert.equal(metadata.nextOffset, 3);
      assert.equal(metadata.viewedRange, "2-3");
    } finally {
      cleanup();
    }
  });

  test("missing file returns ok=false", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new ReadTool();
      const result = await tool.execute({ path: "nonexistent.txt" }, createContext(root));
      assert.equal(result.ok, false);
      assert.ok(result.error);
    } finally {
      cleanup();
    }
  });

  test("missing path argument returns ok=false", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new ReadTool();
      const result = await tool.execute({}, createContext(root));
      assert.equal(result.ok, false);
      assert.match(result.error!, /path is required/i);
    } finally {
      cleanup();
    }
  });

  test("path outside workspace throws", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new ReadTool();
      await assert.rejects(
        () => tool.execute({ path: path.resolve(root, "..", "outside.txt") }, createContext(root)),
        /Access denied|outside workspace/i
      );
    } finally {
      cleanup();
    }
  });
});

/* ============================================================
 *  LS TOOL CONTRACT
 * ============================================================ */

describe("ls tool contract", () => {
  test("lists directory entries non-recursively", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new LsTool();
      const result = await tool.execute({ path: "." }, createContext(root));
      assert.equal(result.ok, true);

      const data = result.data as Record<string, unknown>;
      const entries = data.entries as Array<{ path: string; isDirectory: boolean; depth: number }>;

      // Should contain top-level items only
      const names = entries.map((e) => e.path);
      assert.ok(names.includes("src/") || names.some((n) => n === "src"));
      assert.ok(names.includes("docs/") || names.some((n) => n === "docs"));
      assert.ok(names.some((n) => n.includes("package.json")));

      // Contract: depth is always 1 for ls
      for (const entry of entries) {
        assert.equal(entry.depth, 1);
      }

      // Hidden files should NOT appear by default
      assert.ok(!names.some((n) => n.includes(".hidden")));

      // Shape checks
      assert.equal(typeof data.total, "number");
      assert.equal(typeof data.truncated, "boolean");
      assert.equal(typeof data.content, "string");
    } finally {
      cleanup();
    }
  });

  test("show_hidden reveals hidden files", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new LsTool();
      const result = await tool.execute({ path: ".", show_hidden: true }, createContext(root));
      assert.equal(result.ok, true);

      const data = result.data as Record<string, unknown>;
      const entries = data.entries as Array<{ path: string }>;
      const names = entries.map((e) => e.path);
      assert.ok(names.some((n) => n.includes(".hidden")));
    } finally {
      cleanup();
    }
  });

  test("pattern filter works", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new LsTool();
      const result = await tool.execute({ path: ".", pattern: "*.json" }, createContext(root));
      assert.equal(result.ok, true);

      const data = result.data as Record<string, unknown>;
      const entries = data.entries as Array<{ path: string }>;
      assert.ok(entries.length > 0);
      for (const entry of entries) {
        assert.ok(entry.path.endsWith(".json") || entry.path.endsWith(".json/"));
      }
    } finally {
      cleanup();
    }
  });

  test("nonexistent directory returns ok=false", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new LsTool();
      const result = await tool.execute({ path: "no_such_dir" }, createContext(root));
      assert.equal(result.ok, false);
      assert.ok(result.error);
    } finally {
      cleanup();
    }
  });

  test("legacy arguments rejected", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new LsTool();
      const result = await tool.execute(
        { path: ".", recursive: true, max_depth: 5 },
        createContext(root)
      );
      assert.equal(result.ok, false);
      assert.match(result.error!, /no longer supports/i);
    } finally {
      cleanup();
    }
  });
});

/* ============================================================
 *  GLOB TOOL CONTRACT
 * ============================================================ */

describe("glob tool contract", () => {
  test("finds files by pattern", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new GlobTool();
      const result = await tool.execute(
        { search_path: ".", pattern: "*.ts" },
        createContext(root)
      );
      assert.equal(result.ok, true);

      const data = result.data as Record<string, unknown>;
      const matches = data.matches as Array<{
        absolutePath: string;
        relativePath: string;
        isDirectory: boolean;
        sizeBytes: number;
      }>;

      // Shape checks
      assert.equal(typeof data.searchPath, "string");
      assert.equal(data.pattern, "*.ts");
      assert.equal(typeof data.total, "number");
      assert.equal(typeof data.truncated, "boolean");

      // Should find all .ts files recursively
      assert.ok(matches.length >= 3); // index.ts, util.ts, deep.ts
      for (const match of matches) {
        assert.ok(match.absolutePath.endsWith(".ts"));
        assert.equal(typeof match.relativePath, "string");
        assert.equal(match.isDirectory, false);
        assert.equal(typeof match.sizeBytes, "number");
      }
    } finally {
      cleanup();
    }
  });

  test("max_results limits output", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new GlobTool();
      const result = await tool.execute(
        { search_path: ".", pattern: "*.ts", max_results: 1 },
        createContext(root)
      );
      assert.equal(result.ok, true);

      const data = result.data as Record<string, unknown>;
      const matches = data.matches as unknown[];
      assert.equal(matches.length, 1);
      assert.equal(data.truncated, true);
    } finally {
      cleanup();
    }
  });

  test("nonexistent directory returns ok=false", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new GlobTool();
      const result = await tool.execute(
        { search_path: "no_such_dir", pattern: "*" },
        createContext(root)
      );
      assert.equal(result.ok, false);
      assert.ok(result.error);
    } finally {
      cleanup();
    }
  });
});

/* ============================================================
 *  GREP TOOL CONTRACT
 * ============================================================ */

describe("grep tool contract", () => {
  test("finds plain text matches with context", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new GrepTool();
      const result = await tool.execute(
        { search_path: ".", query: "hello", context_lines: 1 },
        createContext(root)
      );
      assert.equal(result.ok, true);

      const data = result.data as Record<string, unknown>;
      const hits = data.hits as Array<{
        file: string;
        lineNumber: number;
        lineContent: string;
        before: string[];
        after: string[];
      }>;

      // Shape checks
      assert.equal(data.query, "hello");
      assert.equal(typeof data.total, "number");
      assert.equal(typeof data.truncated, "boolean");

      assert.ok(hits.length > 0);
      for (const hit of hits) {
        assert.equal(typeof hit.file, "string");
        assert.equal(typeof hit.lineNumber, "number");
        assert.equal(typeof hit.lineContent, "string");
        assert.ok(Array.isArray(hit.before));
        assert.ok(Array.isArray(hit.after));
      }
    } finally {
      cleanup();
    }
  });

  test("regex search works", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new GrepTool();
      const result = await tool.execute(
        { search_path: ".", query: "DEEP_\\w+", is_regex: true },
        createContext(root)
      );
      assert.equal(result.ok, true);

      const data = result.data as Record<string, unknown>;
      const hits = data.hits as Array<{ lineContent: string }>;
      assert.ok(hits.length >= 2); // DEEP_VALUE and DEEP_NAME
    } finally {
      cleanup();
    }
  });

  test("case_sensitive=true narrows results", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new GrepTool();

      const insensitive = await tool.execute(
        { search_path: ".", query: "HELLO" },
        createContext(root)
      );

      const sensitive = await tool.execute(
        { search_path: ".", query: "HELLO", case_sensitive: true },
        createContext(root)
      );

      const insensitiveHits = ((insensitive.data as Record<string, unknown>).hits as unknown[]);
      const sensitiveHits = ((sensitive.data as Record<string, unknown>).hits as unknown[]);

      // "hello" appears in code but "HELLO" (uppercase) should not match case-sensitive
      assert.ok(insensitiveHits.length > sensitiveHits.length);
    } finally {
      cleanup();
    }
  });

  test("includes filter limits file scope", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new GrepTool();
      const result = await tool.execute(
        { search_path: ".", query: "export", includes: ["*.md"] },
        createContext(root)
      );
      assert.equal(result.ok, true);

      const data = result.data as Record<string, unknown>;
      const hits = data.hits as Array<{ file: string }>;
      // "export" appears in .ts files but not .md files
      assert.equal(hits.length, 0);
    } finally {
      cleanup();
    }
  });

  test("max_results limits output", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new GrepTool();
      const result = await tool.execute(
        { search_path: ".", query: "export", max_results: 1 },
        createContext(root)
      );
      assert.equal(result.ok, true);

      const data = result.data as Record<string, unknown>;
      const hits = data.hits as unknown[];
      assert.equal(hits.length, 1);
      assert.equal(data.truncated, true);
    } finally {
      cleanup();
    }
  });

  test("invalid regex returns ok=false", async () => {
    const { root, cleanup } = setupFixture();
    try {
      const tool = new GrepTool();
      const result = await tool.execute(
        { search_path: ".", query: "[invalid", is_regex: true },
        createContext(root)
      );
      assert.equal(result.ok, false);
      assert.match(result.error!, /invalid regex/i);
    } finally {
      cleanup();
    }
  });
});
