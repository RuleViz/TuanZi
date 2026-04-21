import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DeclarativeStore } from "../memory/declarative-store";

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "tuanzi-memory-test-"));
}

test("DeclarativeStore: getSoul returns empty string when SOUL.md does not exist", () => {
  const globalDir = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    assert.equal(store.getSoul(), "");
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test("DeclarativeStore: getSoul returns file contents when SOUL.md exists", () => {
  const globalDir = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    store.writeSoul("You are TuanZi.");
    assert.equal(store.getSoul(), "You are TuanZi.");
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test("DeclarativeStore: getGlobalMemory returns empty string when MEMORY.md does not exist", () => {
  const globalDir = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    assert.equal(store.getGlobalMemory(), "");
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test("DeclarativeStore: appendToMemory creates MEMORY.md if missing", () => {
  const globalDir = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    store.appendToMemory("- Prefers TypeScript strict mode", "global");
    const content = store.getGlobalMemory();
    assert.ok(content.includes("- Prefers TypeScript strict mode"));
    assert.ok(existsSync(path.join(globalDir, "MEMORY.md")));
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test("DeclarativeStore: appendToMemory appends content without overwriting", () => {
  const globalDir = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    store.appendToMemory("- First entry", "global");
    store.appendToMemory("- Second entry", "global");
    const content = store.getGlobalMemory();
    assert.ok(content.includes("- First entry"));
    assert.ok(content.includes("- Second entry"));
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test("DeclarativeStore: getProjectMemory returns empty when project MEMORY.md missing", () => {
  const globalDir = makeTmpDir();
  const workspaceRoot = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    assert.equal(store.getProjectMemory(workspaceRoot), "");
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("DeclarativeStore: appendToMemory with project scope writes to workspaceRoot/.tuanzi/MEMORY.md", () => {
  const globalDir = makeTmpDir();
  const workspaceRoot = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    store.appendToMemory("- Uses vitest for tests", "project", workspaceRoot);
    const content = store.getProjectMemory(workspaceRoot);
    assert.ok(content.includes("- Uses vitest for tests"));
    assert.ok(existsSync(path.join(workspaceRoot, ".tuanzi", "MEMORY.md")));
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("DeclarativeStore: global and project memories are independent", () => {
  const globalDir = makeTmpDir();
  const workspaceRoot = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    store.appendToMemory("- Global fact", "global");
    store.appendToMemory("- Project fact", "project", workspaceRoot);

    assert.ok(store.getGlobalMemory().includes("- Global fact"));
    assert.ok(!store.getGlobalMemory().includes("- Project fact"));
    assert.ok(store.getProjectMemory(workspaceRoot).includes("- Project fact"));
    assert.ok(!store.getProjectMemory(workspaceRoot).includes("- Global fact"));
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("DeclarativeStore: overwriteMemory replaces entire file content", () => {
  const globalDir = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    store.appendToMemory("- Old content", "global");
    store.overwriteMemory("# New Memory\n- Fresh start", "global");
    const content = store.getGlobalMemory();
    assert.ok(content.includes("- Fresh start"));
    assert.ok(!content.includes("- Old content"));
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test("DeclarativeStore: getMemorySize returns character count of global MEMORY.md", () => {
  const globalDir = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    assert.equal(store.getMemorySize("global"), 0);
    store.appendToMemory("hello", "global");
    assert.ok(store.getMemorySize("global") >= 5);
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
  }
});
