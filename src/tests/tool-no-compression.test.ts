import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ToolExecutionContext } from "../core/types";
import { BashTool } from "../tools/bash";
import { normalizeExtractedBrowserText } from "../tools/browser-action";
import { GlobTool } from "../tools/glob";
import { GrepTool } from "../tools/grep";

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

test("bash should keep full stdout when max_output_chars is omitted", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-bash-all-"));
  try {
    const tool = new BashTool();
    const longOutput = "x".repeat(6200);
    const command = `node -e "process.stdout.write('${longOutput}')"`;

    const result = await tool.execute({ command }, createContext(workspaceDir));

    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    assert.equal(String(data.stdout ?? "").length, longOutput.length);
    assert.equal(String(data.stdout ?? ""), longOutput);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("bash should still respect explicit max_output_chars", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-bash-limit-"));
  try {
    const tool = new BashTool();
    const longOutput = "y".repeat(2000);
    const command = `node -e "process.stdout.write('${longOutput}')"`;

    const result = await tool.execute({ command, max_output_chars: 500 }, createContext(workspaceDir));

    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    const stdout = String(data.stdout ?? "");
    assert.ok(stdout.length <= 500);
    assert.match(stdout, /omitted/);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("normalizeExtractedBrowserText should keep full extracted text", () => {
  const longText = "browser-text-".repeat(600);
  const normalized = normalizeExtractedBrowserText(longText);
  assert.equal(normalized.length, longText.length);
  assert.equal(normalized, longText);
});

test("glob should return all matches when max_results is omitted", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-glob-all-"));
  try {
    mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
    for (let index = 0; index < 230; index += 1) {
      writeFileSync(path.join(workspaceDir, "src", `match-${index}.ts`), "export {};\n", "utf8");
    }

    const tool = new GlobTool();
    const result = await tool.execute(
      { search_path: "src", pattern: "*.ts" },
      createContext(workspaceDir)
    );

    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    const matches = data.matches as Array<{ relativePath: string }>;
    assert.equal(matches.length, 230);
    assert.equal(data.truncated, false);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("glob should still respect explicit max_results", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-glob-limit-"));
  try {
    mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
    for (let index = 0; index < 12; index += 1) {
      writeFileSync(path.join(workspaceDir, "src", `match-${index}.ts`), "export {};\n", "utf8");
    }

    const tool = new GlobTool();
    const result = await tool.execute(
      { search_path: "src", pattern: "*.ts", max_results: 5 },
      createContext(workspaceDir)
    );

    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    const matches = data.matches as Array<{ relativePath: string }>;
    assert.equal(matches.length, 5);
    assert.equal(data.truncated, true);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("grep should return all hits when max_results is omitted", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-grep-all-"));
  try {
    const hits = Array.from({ length: 150 }, () => "needle").join("\n");
    writeFileSync(path.join(workspaceDir, "sample.txt"), hits, "utf8");

    const tool = new GrepTool();
    const result = await tool.execute(
      { search_path: "sample.txt", query: "needle" },
      createContext(workspaceDir)
    );

    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    const foundHits = data.hits as Array<{ lineNumber: number }>;
    assert.equal(foundHits.length, 150);
    assert.equal(data.truncated, false);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("grep should still respect explicit max_results", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-grep-limit-"));
  try {
    const hits = Array.from({ length: 20 }, () => "needle").join("\n");
    writeFileSync(path.join(workspaceDir, "sample.txt"), hits, "utf8");

    const tool = new GrepTool();
    const result = await tool.execute(
      { search_path: "sample.txt", query: "needle", max_results: 7 },
      createContext(workspaceDir)
    );

    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    const foundHits = data.hits as Array<{ lineNumber: number }>;
    assert.equal(foundHits.length, 7);
    assert.equal(data.truncated, true);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
