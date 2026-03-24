import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FileSystemSkillRuntime } from "../core/skill-store";

function withEnv(overrides: Record<string, string | null>, fn: () => void): void {
  const backup: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    backup[key] = process.env[key];
    if (value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(backup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function writeSkill(rootDir: string, name: string, description: string, body = "Body"): void {
  const skillDir = path.join(rootDir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${description}`, "---", body, ""].join("\n"),
    "utf8"
  );
}

test("FileSystemSkillRuntime should scan roots and prefer home skill on duplicate names", () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-workspace-"));
  const homeSkillRoot = path.join(homeDir, "skills");
  const workspaceSkillRoot = path.join(workspaceDir, ".tuanzi", "skills");

  try {
    writeSkill(homeSkillRoot, "shared-skill", "home wins", "home body");
    writeSkill(workspaceSkillRoot, "shared-skill", "workspace loses", "workspace body");
    writeSkill(workspaceSkillRoot, "workspace-only", "workspace skill", "workspace only body");

    withEnv({ TUANZI_HOME: homeDir, MYCODERAGENT_HOME: null }, () => {
      const runtime = new FileSystemSkillRuntime(workspaceDir);
      const catalog = runtime.listCatalog();
      assert.deepEqual(
        catalog.map((item) => item.name),
        ["shared-skill", "workspace-only"]
      );
      const shared = catalog.find((item) => item.name === "shared-skill");
      assert.equal(shared?.description, "home wins");

      const loaded = runtime.loadSkill("shared-skill");
      assert.equal(loaded.body, "home body");
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("FileSystemSkillRuntime should skip invalid skill directories", () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-workspace-"));
  const workspaceSkillRoot = path.join(workspaceDir, ".tuanzi", "skills");

  try {
    writeSkill(workspaceSkillRoot, "valid-skill", "ok");
    const invalidDir = path.join(workspaceSkillRoot, "broken-skill");
    mkdirSync(invalidDir, { recursive: true });
    writeFileSync(
      path.join(invalidDir, "SKILL.md"),
      ["---", "name: wrong-name", "description: mismatch", "---", "Body"].join("\n"),
      "utf8"
    );

    withEnv({ TUANZI_HOME: homeDir, MYCODERAGENT_HOME: null }, () => {
      const runtime = new FileSystemSkillRuntime(workspaceDir);
      const catalog = runtime.listCatalog();
      assert.deepEqual(catalog.map((item) => item.name), ["valid-skill"]);
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("FileSystemSkillRuntime refreshCatalog should pick up newly added skills", () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-workspace-"));
  const workspaceSkillRoot = path.join(workspaceDir, ".tuanzi", "skills");

  try {
    writeSkill(workspaceSkillRoot, "doc", "doc skill");
    withEnv({ TUANZI_HOME: homeDir, MYCODERAGENT_HOME: null }, () => {
      const runtime = new FileSystemSkillRuntime(workspaceDir);
      assert.deepEqual(
        runtime.listCatalog().map((item) => item.name),
        ["doc"]
      );

      writeSkill(workspaceSkillRoot, "slides", "slides skill");
      assert.deepEqual(
        runtime.listCatalog().map((item) => item.name),
        ["doc"]
      );

      runtime.refreshCatalog();
      assert.deepEqual(
        runtime.listCatalog().map((item) => item.name),
        ["doc", "slides"]
      );
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
