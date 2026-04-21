import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DeclarativeStore } from "../memory/declarative-store";
import { MemoryInjector } from "../memory/memory-injector";

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "tuanzi-minj-"));
}

test("MemoryInjector: returns empty string when no memory files exist", () => {
  const globalDir = makeTmpDir();
  const workspaceRoot = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    const injector = new MemoryInjector(store);
    const block = injector.buildDeclarativeBlock(workspaceRoot);
    assert.equal(block, "");
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("MemoryInjector: includes SOUL.md content when present", () => {
  const globalDir = makeTmpDir();
  const workspaceRoot = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    store.writeSoul("You are TuanZi, a helpful agent.");
    const injector = new MemoryInjector(store);
    const block = injector.buildDeclarativeBlock(workspaceRoot);
    assert.ok(block.includes("You are TuanZi, a helpful agent."));
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("MemoryInjector: includes global MEMORY.md content when present", () => {
  const globalDir = makeTmpDir();
  const workspaceRoot = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    store.appendToMemory("- Uses TypeScript strict mode", "global");
    const injector = new MemoryInjector(store);
    const block = injector.buildDeclarativeBlock(workspaceRoot);
    assert.ok(block.includes("- Uses TypeScript strict mode"));
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("MemoryInjector: includes project MEMORY.md content when present", () => {
  const globalDir = makeTmpDir();
  const workspaceRoot = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    store.appendToMemory("- Monorepo layout: src/ + app/", "project", workspaceRoot);
    const injector = new MemoryInjector(store);
    const block = injector.buildDeclarativeBlock(workspaceRoot);
    assert.ok(block.includes("- Monorepo layout: src/ + app/"));
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("MemoryInjector: combines all three memory sources when present", () => {
  const globalDir = makeTmpDir();
  const workspaceRoot = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    store.writeSoul("Be concise.");
    store.appendToMemory("- Global preference", "global");
    store.appendToMemory("- Project convention", "project", workspaceRoot);

    const injector = new MemoryInjector(store);
    const block = injector.buildDeclarativeBlock(workspaceRoot);

    assert.ok(block.includes("Be concise."));
    assert.ok(block.includes("- Global preference"));
    assert.ok(block.includes("- Project convention"));
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("MemoryInjector: block is within maxChars limit when specified", () => {
  const globalDir = makeTmpDir();
  const workspaceRoot = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    // Write a lot of content
    const longContent = Array.from({ length: 100 }, (_, i) => `- Fact number ${i}`).join("\n");
    store.appendToMemory(longContent, "global");

    const injector = new MemoryInjector(store);
    const block = injector.buildDeclarativeBlock(workspaceRoot, { maxChars: 200 });
    assert.ok(block.length <= 210, `Block too long: ${block.length}`); // small tolerance for header
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("MemoryInjector: buildEpisodicBlock wraps content in memory-context fence", () => {
  const globalDir = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    const injector = new MemoryInjector(store);
    const block = injector.buildEpisodicBlock("User prefers dark mode.");
    assert.ok(block.includes("<memory-context>"));
    assert.ok(block.includes("User prefers dark mode."));
    assert.ok(block.includes("</memory-context>"));
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test("MemoryInjector: buildEpisodicBlock returns empty string for empty input", () => {
  const globalDir = makeTmpDir();
  try {
    const store = new DeclarativeStore({ globalDir });
    const injector = new MemoryInjector(store);
    assert.equal(injector.buildEpisodicBlock(""), "");
    assert.equal(injector.buildEpisodicBlock("   "), "");
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
  }
});
