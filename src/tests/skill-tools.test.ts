import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createSkillRuntime } from "../core/skill-store";
import type { ToolExecutionContext } from "../core/types";
import { SkillLoadTool } from "../tools/skill-load";
import { SkillListTool } from "../tools/skill-list";
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
      const data = result.data as Record<string, unknown>;
      assert.equal(data.name, "pdf-processing");
      assert.match(String(data.body), /Read references first/);
      assert.equal(Array.isArray(data.skills), true);
      assert.equal(data.loadedCount, 1);
      assert.deepEqual(data.missing, []);
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("skill_load should support batch loading with names[]", async () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-workspace-"));
  const skillRoot = path.join(workspaceDir, ".tuanzi", "skills");
  mkdirSync(path.join(skillRoot, "doc"), { recursive: true });
  mkdirSync(path.join(skillRoot, "slides"), { recursive: true });
  writeFileSync(path.join(skillRoot, "doc", "SKILL.md"), ["---", "name: doc", "description: doc skill", "---", "doc"].join("\n"), "utf8");
  writeFileSync(
    path.join(skillRoot, "slides", "SKILL.md"),
    ["---", "name: slides", "description: slides skill", "---", "slides"].join("\n"),
    "utf8"
  );

  try {
    await withEnv({ TUANZI_HOME: homeDir, MYCODERAGENT_HOME: null }, async () => {
      const tool = new SkillLoadTool();
      const result = await tool.execute({ names: ["doc", "slides"] }, createContext(workspaceDir));
      assert.equal(result.ok, true);
      const data = result.data as Record<string, unknown>;
      assert.equal(data.loadedCount, 2);
      assert.deepEqual(data.missing, []);
      const skills = data.skills as Array<{ name: string }>;
      assert.deepEqual(
        skills.map((item) => item.name).sort(),
        ["doc", "slides"]
      );
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("skill_load should allow partial success for batch requests", async () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-workspace-"));
  const skillDir = path.join(workspaceDir, ".tuanzi", "skills", "doc");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), ["---", "name: doc", "description: doc skill", "---", "doc"].join("\n"), "utf8");

  try {
    await withEnv({ TUANZI_HOME: homeDir, MYCODERAGENT_HOME: null }, async () => {
      const tool = new SkillLoadTool();
      const result = await tool.execute({ names: ["doc", "missing-skill"] }, createContext(workspaceDir));
      assert.equal(result.ok, true);
      const data = result.data as Record<string, unknown>;
      assert.equal(data.loadedCount, 1);
      assert.deepEqual(data.missing, ["missing-skill"]);
      const skills = data.skills as Array<{ name: string }>;
      assert.deepEqual(skills.map((item) => item.name), ["doc"]);
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("skill_list should refresh catalog and return newly added skills", async () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-workspace-"));
  const root = path.join(workspaceDir, ".tuanzi", "skills");
  const docDir = path.join(root, "doc");
  mkdirSync(docDir, { recursive: true });
  writeFileSync(path.join(docDir, "SKILL.md"), ["---", "name: doc", "description: doc", "---", "doc"].join("\n"), "utf8");

  try {
    await withEnv({ TUANZI_HOME: homeDir, MYCODERAGENT_HOME: null }, async () => {
      const context = createContext(workspaceDir);
      const listTool = new SkillListTool();

      const first = await listTool.execute({}, context);
      assert.equal(first.ok, true);
      assert.equal((first.data as Record<string, unknown>).returned, 1);

      const slidesDir = path.join(root, "slides");
      mkdirSync(slidesDir, { recursive: true });
      writeFileSync(
        path.join(slidesDir, "SKILL.md"),
        ["---", "name: slides", "description: slides", "---", "slides"].join("\n"),
        "utf8"
      );

      const stale = await listTool.execute({ refresh_catalog: false }, context);
      assert.equal(stale.ok, true);
      assert.equal((stale.data as Record<string, unknown>).returned, 1);

      const refreshed = await listTool.execute({ refresh_catalog: true }, context);
      assert.equal(refreshed.ok, true);
      assert.equal((refreshed.data as Record<string, unknown>).returned, 2);
      const skills = (refreshed.data as Record<string, unknown>).skills as Array<{ name: string }>;
      assert.deepEqual(
        skills.map((item) => item.name).sort(),
        ["doc", "slides"]
      );
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
