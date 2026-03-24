import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ToolExecutionContext } from "../core/types";
import { EditTool } from "../tools/edit";

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

test("edit should apply a valid unified diff", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-edit-valid-"));
  try {
    const filePath = path.join(workspaceDir, "sample.txt");
    writeFileSync(filePath, "line-1\nline-2\nline-3\n", "utf8");

    const diff = ["@@ -1,3 +1,3 @@", " line-1", "-line-2", "+line-2-updated", " line-3"].join("\n");

    const tool = new EditTool();
    const result = await tool.execute({ targetFile: "sample.txt", diff }, createContext(workspaceDir));

    assert.equal(result.ok, true);
    assert.equal(readFileSync(filePath, "utf8"), "line-1\nline-2-updated\nline-3\n");
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("edit should return actionable guidance for invalid diff format", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-edit-invalid-diff-"));
  try {
    writeFileSync(path.join(workspaceDir, "sample.txt"), "alpha\nbeta\n", "utf8");

    const tool = new EditTool();
    const result = await tool.execute(
      {
        targetFile: "sample.txt",
        diff: "replace line beta with gamma"
      },
      createContext(workspaceDir)
    );

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /@@/);
    assert.match(result.error ?? "", /must start with [' +\-]/i);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("edit should include mismatch context details when hunk cannot be applied", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-edit-hunk-mismatch-"));
  try {
    writeFileSync(path.join(workspaceDir, "sample.txt"), "alpha\nbeta\ncharlie\n", "utf8");

    const diff = ["@@ -1,3 +1,3 @@", " alpha", "-beta-typo", "+beta-fixed", " charlie"].join("\n");
    const tool = new EditTool();
    const result = await tool.execute({ targetFile: "sample.txt", diff, fuzz: 0 }, createContext(workspaceDir));

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /failed to match/i);
    assert.match(result.error ?? "", /beta-typo/);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("edit should return friendly path validation error instead of throwing", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-edit-outside-path-"));
  try {
    const outsidePath = path.resolve(workspaceDir, "..", "outside-edit-target.txt");
    const diff = ["@@ -1,1 +1,1 @@", "-x", "+y"].join("\n");
    const tool = new EditTool();

    const result = await tool.execute({ targetFile: outsidePath, diff }, createContext(workspaceDir));

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /outside workspace root/i);
    assert.match(result.error ?? "", /targetFile/i);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("edit should return friendly error when file does not exist", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-edit-missing-file-"));
  try {
    const diff = ["@@ -1,1 +1,1 @@", "-old", "+new"].join("\n");
    const tool = new EditTool();
    const result = await tool.execute({ targetFile: "missing.txt", diff }, createContext(workspaceDir));

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /file not found or unreadable/i);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
