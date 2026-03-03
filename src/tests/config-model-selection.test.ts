import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadRuntimeConfig } from "../config";

function withEnv(overrides: Record<string, string | null>, fn: () => void): void {
  const backup: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    backup[key] = process.env[key];
    const next = overrides[key];
    if (next === null) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      const prev = backup[key];
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  }
}

test("should not fallback to env vars when no custom model exists", () => {
  withEnv(
    {
      MYCODER_API_KEY: null,
      MYCODER_API_BASE_URL: null,
      MYCODER_MODEL: null,
      MYCODER_PLANNER_MODEL: null,
      MYCODER_SEARCH_MODEL: null,
      MYCODER_CODER_MODEL: null,
      TUANZI_MODELS_PATH: path.join(process.cwd(), ".tmp", "missing-models.json"),
      QWEN_API_KEY: "qwen-demo-key",
      DEEPSEEK_API_KEY: null
    },
    () => {
      const config = loadRuntimeConfig({ workspaceRoot: process.cwd(), approvalMode: "manual" });
      assert.equal(config.model.keySource, "none");
      assert.equal(config.model.apiKey, null);
      assert.equal(config.model.baseUrl, "https://api.openai.com/v1");
      assert.equal(config.model.plannerModel, null);
      assert.equal(config.model.searchModel, null);
      assert.equal(config.model.coderModel, null);
    }
  );
});

test("should still not fallback to env vars when modelOverride misses", () => {
  withEnv(
    {
      MYCODER_API_KEY: "mycoder-key",
      MYCODER_API_BASE_URL: null,
      MYCODER_MODEL: null,
      TUANZI_MODELS_PATH: path.join(process.cwd(), ".tmp", "missing-models.json"),
      QWEN_API_KEY: "qwen-demo-key",
      DEEPSEEK_API_KEY: "deepseek-demo-key"
    },
    () => {
      const config = loadRuntimeConfig({
        workspaceRoot: process.cwd(),
        approvalMode: "manual",
        modelOverride: "not-exists"
      });
      assert.equal(config.model.keySource, "none");
      assert.equal(config.model.apiKey, null);
      assert.equal(config.model.baseUrl, "https://api.openai.com/v1");
      assert.equal(config.model.plannerModel, null);
      assert.equal(config.model.searchModel, null);
      assert.equal(config.model.coderModel, null);
    }
  );
});

test("should load default model from custom store", () => {
  const storeDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-model-store-"));
  const storePath = path.join(storeDir, "models.json");
  writeFileSync(
    storePath,
    JSON.stringify(
      {
        defaultModel: "my-ollama",
        models: [
          {
            name: "deepseek-cloud",
            baseUrl: "https://api.deepseek.com/v1",
            modelId: "deepseek-chat",
            apiKey: "sk-deepseek"
          },
          {
            name: "my-ollama",
            baseUrl: "http://127.0.0.1:11434/v1",
            modelId: "qwen2.5-coder",
            apiKey: "none"
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  try {
    withEnv(
      {
        TUANZI_MODELS_PATH: storePath,
        MYCODER_API_KEY: null,
        MYCODER_API_BASE_URL: null,
        MYCODER_MODEL: null,
        MYCODER_PLANNER_MODEL: null,
        MYCODER_SEARCH_MODEL: null,
        MYCODER_CODER_MODEL: null,
        QWEN_API_KEY: null,
        DEEPSEEK_API_KEY: null
      },
      () => {
        const config = loadRuntimeConfig({ workspaceRoot: process.cwd(), approvalMode: "manual" });
        assert.equal(config.model.keySource, "openai");
        assert.equal(config.model.baseUrl, "http://127.0.0.1:11434/v1");
        assert.equal(config.model.apiKey, "none");
        assert.equal(config.model.plannerModel, "qwen2.5-coder");
        assert.equal(config.model.searchModel, "qwen2.5-coder");
        assert.equal(config.model.coderModel, "qwen2.5-coder");
      }
    );
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("modelOverride should take priority over store default model", () => {
  const storeDir = mkdtempSync(path.join(os.tmpdir(), "tuanzi-model-store-"));
  const storePath = path.join(storeDir, "models.json");
  writeFileSync(
    storePath,
    JSON.stringify(
      {
        defaultModel: "deepseek-cloud",
        models: [
          {
            name: "deepseek-cloud",
            baseUrl: "https://api.deepseek.com/v1",
            modelId: "deepseek-chat",
            apiKey: "sk-deepseek"
          },
          {
            name: "my-ollama",
            baseUrl: "http://127.0.0.1:11434/v1",
            modelId: "qwen2.5-coder",
            apiKey: "none"
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  try {
    withEnv(
      {
        TUANZI_MODELS_PATH: storePath,
        MYCODER_API_KEY: null,
        MYCODER_API_BASE_URL: null,
        MYCODER_MODEL: null,
        MYCODER_PLANNER_MODEL: null,
        MYCODER_SEARCH_MODEL: null,
        MYCODER_CODER_MODEL: null,
        QWEN_API_KEY: null,
        DEEPSEEK_API_KEY: null
      },
      () => {
        const config = loadRuntimeConfig({
          workspaceRoot: process.cwd(),
          approvalMode: "manual",
          modelOverride: "my-ollama"
        });
        assert.equal(config.model.keySource, "openai");
        assert.equal(config.model.baseUrl, "http://127.0.0.1:11434/v1");
        assert.equal(config.model.apiKey, "none");
        assert.equal(config.model.plannerModel, "qwen2.5-coder");
        assert.equal(config.model.searchModel, "qwen2.5-coder");
        assert.equal(config.model.coderModel, "qwen2.5-coder");
      }
    );
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});
