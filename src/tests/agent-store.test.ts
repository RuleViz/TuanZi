import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  deleteStoredAgentSync,
  getStoredAgentSync,
  listStoredAgentsSync,
  loadAgentBackendConfigSync,
  saveAgentBackendConfigSync,
  saveStoredAgentSync
} from "../core/agent-store";

function withAgentHome(homePath: string, fn: () => void): void {
  const previous = process.env.MYCODERAGENT_HOME;
  process.env.MYCODERAGENT_HOME = homePath;
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env.MYCODERAGENT_HOME;
    } else {
      process.env.MYCODERAGENT_HOME = previous;
    }
  }
}

test("agent store should bootstrap default config and default agent", () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "mycoderagent-home-"));
  try {
    withAgentHome(homeDir, () => {
      const config = loadAgentBackendConfigSync();
      assert.equal(config.provider.type, "openai");
      assert.equal(Array.isArray(config.providers), true);
      assert.equal(typeof config.activeProviderId, "string");

      const agents = listStoredAgentsSync();
      assert.equal(agents.length >= 1, true);
      assert.equal(agents[0].filename, "default.md");
      assert.equal(agents[0].prompt.length > 0, true);
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("agent store should save and delete custom agents", () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "mycoderagent-home-"));
  try {
    withAgentHome(homeDir, () => {
      const saved = saveStoredAgentSync({
        filename: "fullstack.md",
        name: "全栈架构师",
        avatar: "💻",
        description: "全栈开发助手",
        tags: ["frontend", "backend"],
        tools: ["view_file", "write_to_file", "run_command"],
        prompt: "你是一个全栈开发助手。"
      });

      assert.equal(saved.filename, "fullstack.md");
      assert.equal(saved.tools.includes("run_command"), true);

      const loaded = getStoredAgentSync("fullstack");
      assert.equal(loaded.name, "全栈架构师");
      assert.equal(loaded.description, "全栈开发助手");

      deleteStoredAgentSync("fullstack");
      assert.throws(() => getStoredAgentSync("fullstack"), /not found/i);
      assert.throws(() => deleteStoredAgentSync("default"), /cannot be deleted/i);
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("agent backend config should persist provider updates", () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "mycoderagent-home-"));
  try {
    withAgentHome(homeDir, () => {
      const saved = saveAgentBackendConfigSync({
        provider: {
          type: "openai",
          apiKey: "sk-test",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o"
        }
      });

      const reloaded = loadAgentBackendConfigSync();
      assert.equal(reloaded.provider.model, "gpt-4o");
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
