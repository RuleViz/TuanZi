import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createSkillRuntime } from "../core/skill-store";
import type { ToolExecutionContext } from "../core/types";
import { SkillLoadTool } from "../tools/skill-load";
import { SkillReadResourceTool } from "../tools/skill-read-resource";

function withEnv(overrides: Record<string, string | null>, fn: () => Promise<void>): Promise<void> {
  const backup: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    backup[key] = process.env[key];
    if (value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(backup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function createContext(workspaceRoot: string): ToolExecutionContext {
  return {
    workspaceRoot,
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
    },
    skillRuntime: createSkillRuntime(workspaceRoot)
  };
}

test("skill_load should return structured SKILL.md data", async () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-workspace-"));
  const skillDir = path.join(workspaceDir, ".tuanzi", "skills", "pdf-processing");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: pdf-processing",
      "description: Parse PDF files",
      "allowed-tools:",
      "  - bash",
      "---",
      "Read references first."
    ].join("\n"),
    "utf8"
  );

  try {
    await withEnv({ TUANZI_HOME: homeDir, MYCODERAGENT_HOME: null }, async () => {
      const tool = new SkillLoadTool();
      const result = await tool.execute({ name: "pdf-processing" }, createContext(workspaceDir));
      assert.equal(result.ok, true);
      assert.equal((result.data as Record<string, unknown>).name, "pdf-processing");
      assert.match(String((result.data as Record<string, unknown>).body), /Read references first/);
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("skill_read_resource should read resource and block path traversal", async () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-workspace-"));
  const skillDir = path.join(workspaceDir, ".tuanzi", "skills", "web-audit");
  mkdirSync(path.join(skillDir, "references"), { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    ["---", "name: web-audit", "description: Audit websites", "---", "Use references/checklist.md"].join("\n"),
    "utf8"
  );
  writeFileSync(path.join(skillDir, "references", "checklist.md"), "- run lighthouse", "utf8");

  try {
    await withEnv({ TUANZI_HOME: homeDir, MYCODERAGENT_HOME: null }, async () => {
      const tool = new SkillReadResourceTool();
      const context = createContext(workspaceDir);
      const okResult = await tool.execute(
        {
          name: "web-audit",
          relative_path: "references/checklist.md"
        },
        context
      );
      assert.equal(okResult.ok, true);
      assert.match(String((okResult.data as Record<string, unknown>).content), /lighthouse/);

      const blocked = await tool.execute(
        {
          name: "web-audit",
          relative_path: "references/../../SKILL.md"
        },
        context
      );
      assert.equal(blocked.ok, false);
      assert.match(blocked.error ?? "", /outside skill directory/i);
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
