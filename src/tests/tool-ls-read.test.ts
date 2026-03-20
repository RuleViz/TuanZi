import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LsTool } from "../tools/ls";
import { ReadTool } from "../tools/read";
import type { ToolExecutionContext } from "../core/types";

function createContext(workspaceRoot: string, signal?: AbortSignal): ToolExecutionContext {
  return {
    workspaceRoot,
    signal,
    approvalGate: {
      async approve() {
        return { approved: true };
      }
    },
    backupManager: {
      async backupFile() {
        return null;
      }
    },
    logger: {
      info() {
        return;
      },
      warn() {
        return;
      },
      error() {
        return;
      }
    }
  };
}

test("ls should list only one directory level", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-ls-"));
  try {
    mkdirSync(path.join(workspaceDir, "src", "nested"), { recursive: true });
    writeFileSync(path.join(workspaceDir, "src", "index.ts"), "export {};\n", "utf8");
    writeFileSync(path.join(workspaceDir, "src", "nested", "deep.ts"), "export const deep = 1;\n", "utf8");

    const tool = new LsTool();
    const result = await tool.execute({ path: "src" }, createContext(workspaceDir));

    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    const content = String(data.content ?? "");
    assert.match(content, /index\.ts/);
    assert.match(content, /nested\//);
    assert.doesNotMatch(content, /deep\.ts/);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("ls should apply limit and mark truncated", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-ls-limit-"));
  try {
    mkdirSync(path.join(workspaceDir, "big"), { recursive: true });
    writeFileSync(path.join(workspaceDir, "big", "a.txt"), "a\n", "utf8");
    writeFileSync(path.join(workspaceDir, "big", "b.txt"), "b\n", "utf8");
    writeFileSync(path.join(workspaceDir, "big", "c.txt"), "c\n", "utf8");

    const tool = new LsTool();
    const result = await tool.execute({ path: "big", limit: 2 }, createContext(workspaceDir));

    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    assert.equal(data.truncated, true);
    const entries = data.entries as Array<{ path: string }>;
    assert.equal(entries.length, 2);
    assert.match(String(data.content ?? ""), /output truncated/i);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("ls should return all entries when limit is omitted", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-ls-all-"));
  try {
    mkdirSync(path.join(workspaceDir, "wide"), { recursive: true });
    for (let index = 0; index < 2105; index += 1) {
      writeFileSync(path.join(workspaceDir, "wide", `file-${index}.txt`), `${index}\n`, "utf8");
    }

    const tool = new LsTool();
    const result = await tool.execute({ path: "wide" }, createContext(workspaceDir));

    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    const entries = data.entries as Array<{ path: string }>;
    assert.equal(entries.length, 2105);
    assert.equal(data.truncated, false);
    assert.doesNotMatch(String(data.content ?? ""), /output truncated/i);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("ls should stop when signal is already aborted", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-ls-abort-"));
  try {
    const controller = new AbortController();
    controller.abort();
    const tool = new LsTool();

    await assert.rejects(
      () => tool.execute({ path: "." }, createContext(workspaceDir, controller.signal)),
      /Interrupted by user/
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("ls should reject legacy recursive arguments", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-ls-legacy-"));
  try {
    mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
    const tool = new LsTool();
    const result = await tool.execute(
      { path: "src", recursive: true, max_depth: 10 },
      createContext(workspaceDir)
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /no longer supports recursive\/max_depth/i);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("read should support offset and limit pagination metadata", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-read-"));
  try {
    writeFileSync(path.join(workspaceDir, "sample.txt"), ["a", "b", "c", "d"].join("\n"), "utf8");

    const tool = new ReadTool();
    const result = await tool.execute({ path: "sample.txt", offset: 1, limit: 2 }, createContext(workspaceDir));

    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    const metadata = data.metadata as Record<string, unknown>;
    const content = String(data.content ?? "");
    assert.match(content, /2: b/);
    assert.match(content, /3: c/);
    assert.equal(metadata.offset, 1);
    assert.equal(metadata.limit, 2);
    assert.equal(metadata.returnedLines, 2);
    assert.equal(metadata.hasMore, true);
    assert.equal(metadata.nextOffset, 3);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("read should reject missing path and stop on aborted signal", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-read-guard-"));
  try {
    const tool = new ReadTool();

    const missingPath = await tool.execute({ offset: 0, limit: 10 }, createContext(workspaceDir));
    assert.equal(missingPath.ok, false);
    assert.match(missingPath.error ?? "", /path is required/i);

    const legacyArgs = await tool.execute(
      { path: "sample.txt", paths: ["sample.txt"], start_line: 1, end_line: 2 },
      createContext(workspaceDir)
    );
    assert.equal(legacyArgs.ok, false);
    assert.match(legacyArgs.error ?? "", /no longer supports paths\/start_line\/end_line/i);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => tool.execute({ path: "sample.txt" }, createContext(workspaceDir, controller.signal)),
      /Interrupted by user/
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("read should return the whole file when limit is omitted", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-read-all-"));
  try {
    const lines = Array.from({ length: 1205 }, (_, index) => `line-${index + 1}`);
    writeFileSync(path.join(workspaceDir, "sample.txt"), lines.join("\n"), "utf8");

    const tool = new ReadTool();
    const result = await tool.execute({ path: "sample.txt" }, createContext(workspaceDir));

    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    const metadata = data.metadata as Record<string, unknown>;
    const content = String(data.content ?? "");
    assert.match(content, /1: line-1/);
    assert.match(content, /1205: line-1205/);
    assert.equal(metadata.limit, null);
    assert.equal(metadata.returnedLines, 1205);
    assert.equal(metadata.hasMore, false);
    assert.equal(metadata.nextOffset, null);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
