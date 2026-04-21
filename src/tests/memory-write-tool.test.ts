import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DeclarativeStore } from "../memory/declarative-store";
import { MemoryWriteTool } from "../tools/memory-write";
import type { ToolExecutionContext } from "../core/types";

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "tuanzi-mwt-"));
}

function makeContext(workspaceRoot: string): ToolExecutionContext {
  return {
    workspaceRoot,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    approvalGate: { approve: async () => ({ approved: true }) },
    backupManager: {} as ToolExecutionContext["backupManager"],
    agentSettings: null
  } as unknown as ToolExecutionContext;
}

test("MemoryWriteTool: has correct definition name", () => {
  const globalDir = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    const tool = new MemoryWriteTool(store);
    assert.equal(tool.definition.name, "memory_write");
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test("MemoryWriteTool: returns error when content is missing", async () => {
  const globalDir = makeTmpDir();
  const workspaceRoot = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    const tool = new MemoryWriteTool(store);
    const result = await tool.execute({ scope: "global" }, makeContext(workspaceRoot));
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("content"));
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("MemoryWriteTool: returns error when scope is missing", async () => {
  const globalDir = makeTmpDir();
  const workspaceRoot = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    const tool = new MemoryWriteTool(store);
    const result = await tool.execute({ content: "- test" }, makeContext(workspaceRoot));
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("scope"));
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("MemoryWriteTool: returns error for invalid scope", async () => {
  const globalDir = makeTmpDir();
  const workspaceRoot = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    const tool = new MemoryWriteTool(store);
    const result = await tool.execute({ content: "- test", scope: "universe" }, makeContext(workspaceRoot));
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("scope"));
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("MemoryWriteTool: writes to global MEMORY.md when scope=global", async () => {
  const globalDir = makeTmpDir();
  const workspaceRoot = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    const tool = new MemoryWriteTool(store);
    const result = await tool.execute(
      { content: "- Prefers dark theme", scope: "global" },
      makeContext(workspaceRoot)
    );
    assert.equal(result.ok, true);
    assert.ok(store.getGlobalMemory().includes("- Prefers dark theme"));
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("MemoryWriteTool: writes to project MEMORY.md when scope=project", async () => {
  const globalDir = makeTmpDir();
  const workspaceRoot = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    const tool = new MemoryWriteTool(store);
    const result = await tool.execute(
      { content: "- Tests use vitest", scope: "project" },
      makeContext(workspaceRoot)
    );
    assert.equal(result.ok, true);
    assert.ok(store.getProjectMemory(workspaceRoot).includes("- Tests use vitest"));
    assert.equal(store.getGlobalMemory().includes("vitest"), false); // not in global
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("MemoryWriteTool: multiple writes accumulate", async () => {
  const globalDir = makeTmpDir();
  const workspaceRoot = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    const tool = new MemoryWriteTool(store);
    await tool.execute({ content: "- Entry one", scope: "global" }, makeContext(workspaceRoot));
    await tool.execute({ content: "- Entry two", scope: "global" }, makeContext(workspaceRoot));
    const mem = store.getGlobalMemory();
    assert.ok(mem.includes("- Entry one"));
    assert.ok(mem.includes("- Entry two"));
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
