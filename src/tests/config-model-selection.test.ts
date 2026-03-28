import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadRuntimeConfig } from "../config";

const TEST_AGENT_HOME = path.join(process.cwd(), ".tmp", "test-agent-home");

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
      MYCODERAGENT_HOME: TEST_AGENT_HOME,
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
      MYCODERAGENT_HOME: TEST_AGENT_HOME,
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

test("should not fallback to custom store default model without modelOverride", () => {
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
        MYCODERAGENT_HOME: TEST_AGENT_HOME,
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
        assert.equal(config.model.keySource, "none");
        assert.equal(config.model.baseUrl, "https://api.openai.com/v1");
        assert.equal(config.model.apiKey, null);
        assert.equal(config.model.plannerModel, null);
        assert.equal(config.model.searchModel, null);
        assert.equal(config.model.coderModel, null);
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
        MYCODERAGENT_HOME: TEST_AGENT_HOME,
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

test("should load provider model from ~/.tuanzi/config.json when custom model store is empty", () => {
  const agentHome = mkdtempSync(path.join(os.tmpdir(), "mycoderagent-home-"));
  try {
    writeFileSync(
      path.join(agentHome, "config.json"),
      JSON.stringify(
        {
          provider: {
            type: "openai",
            apiKey: "sk-provider",
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-4o"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    withEnv(
      {
        TUANZI_MODELS_PATH: path.join(process.cwd(), ".tmp", "missing-models.json"),
        MYCODERAGENT_HOME: agentHome,
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
        assert.equal(config.model.apiKey, "sk-provider");
        assert.equal(config.model.baseUrl, "https://api.openai.com/v1");
        assert.equal(config.model.coderModel, "gpt-4o");
      }
    );
  } finally {
    rmSync(agentHome, { recursive: true, force: true });
  }
});

test("should not fallback to first provider when activeProviderId is missing", () => {
  const agentHome = mkdtempSync(path.join(os.tmpdir(), "mycoderagent-home-"));
  try {
    writeFileSync(
      path.join(agentHome, "config.json"),
      JSON.stringify(
        {
          provider: {
            type: "openai",
            apiKey: "sk-legacy",
            baseUrl: "https://api.openai.com/v1",
            model: "legacy-model"
          },
          providers: [
            {
              id: "provider-a",
              name: "Provider A",
              type: "openai",
              apiKey: "sk-a",
              baseUrl: "https://a.example.com/v1",
              model: "model-a",
              models: [],
              isEnabled: true
            },
            {
              id: "provider-b",
              name: "Provider B",
              type: "openai",
              apiKey: "sk-b",
              baseUrl: "https://b.example.com/v1",
              model: "model-b",
              models: [],
              isEnabled: true
            }
          ],
          activeProviderId: ""
        },
        null,
        2
      ),
      "utf8"
    );

    withEnv(
      {
        TUANZI_MODELS_PATH: path.join(process.cwd(), ".tmp", "missing-models.json"),
        MYCODERAGENT_HOME: agentHome,
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
        assert.equal(config.model.keySource, "none");
        assert.equal(config.model.apiKey, null);
        assert.equal(config.model.baseUrl, "https://api.openai.com/v1");
        assert.equal(config.model.coderModel, null);
      }
    );
  } finally {
    rmSync(agentHome, { recursive: true, force: true });
  }
});

test("should map agent.config.json modelRequest into runtime model request options", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "tuanzi-workspace-"));
  const agentHome = mkdtempSync(path.join(os.tmpdir(), "mycoderagent-home-"));
  try {
    writeFileSync(
      path.join(workspace, "agent.config.json"),
      JSON.stringify(
        {
          modelRequest: {
            reasoningEffort: "high",
            thinking: {
              type: "enabled",
              budgetTokens: 2048
            },
            extraBody: {
              enable_thinking: true
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    writeFileSync(
      path.join(agentHome, "config.json"),
      JSON.stringify(
        {
          provider: {
            type: "openai",
            apiKey: "sk-provider",
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-4o"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    withEnv(
      {
        TUANZI_MODELS_PATH: path.join(process.cwd(), ".tmp", "missing-models.json"),
        MYCODERAGENT_HOME: agentHome
      },
      () => {
        const config = loadRuntimeConfig({ workspaceRoot: workspace, approvalMode: "manual" });
        assert.deepEqual(config.model.requestOptions, {
          reasoningEffort: "high",
          thinking: {
            type: "enabled",
            budget_tokens: 2048
          },
          extraBody: {
            enable_thinking: true
          }
        });
      }
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(agentHome, { recursive: true, force: true });
  }
});

test("should load contextPruning settings from agent.config.json", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "tuanzi-workspace-"));
  const agentHome = mkdtempSync(path.join(os.tmpdir(), "mycoderagent-home-"));
  try {
    writeFileSync(
      path.join(workspace, "agent.config.json"),
      JSON.stringify(
        {
          contextPruning: {
            toolOutput: {
              protectRecentTokens: 12345,
              pruneMinimumTokens: 6789,
              pruneStrategy: "summarize"
            },
            compaction: {
              enabled: false,
              threshold: 0.9,
              maxRetries: 4
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    writeFileSync(
      path.join(agentHome, "config.json"),
      JSON.stringify(
        {
          provider: {
            type: "openai",
            apiKey: "sk-provider",
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-4o"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    withEnv(
      {
        TUANZI_MODELS_PATH: path.join(process.cwd(), ".tmp", "missing-models.json"),
        MYCODERAGENT_HOME: agentHome
      },
      () => {
        const config = loadRuntimeConfig({ workspaceRoot: workspace, approvalMode: "manual" });
        assert.deepEqual(config.agentSettings.contextPruning.toolOutput, {
          protectRecentTokens: 12345,
          pruneMinimumTokens: 6789,
          pruneStrategy: "summarize"
        });
        assert.deepEqual(config.agentSettings.contextPruning.compaction, {
          enabled: false,
          threshold: 0.9,
          maxRetries: 4
        });
      }
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(agentHome, { recursive: true, force: true });
  }
});

test("should use default contextPruning.compaction when not configured", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "tuanzi-workspace-"));
  const agentHome = mkdtempSync(path.join(os.tmpdir(), "mycoderagent-home-"));
  try {
    writeFileSync(
      path.join(workspace, "agent.config.json"),
      JSON.stringify(
        {
          contextPruning: {
            toolOutput: {
              protectRecentTokens: 12345,
              pruneMinimumTokens: 6789,
              pruneStrategy: "truncate"
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    writeFileSync(
      path.join(agentHome, "config.json"),
      JSON.stringify(
        {
          provider: {
            type: "openai",
            apiKey: "sk-provider",
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-4o"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    withEnv(
      {
        TUANZI_MODELS_PATH: path.join(process.cwd(), ".tmp", "missing-models.json"),
        MYCODERAGENT_HOME: agentHome
      },
      () => {
        const config = loadRuntimeConfig({ workspaceRoot: workspace, approvalMode: "manual" });
        assert.deepEqual(config.agentSettings.contextPruning.compaction, {
          enabled: true,
          threshold: 0.85,
          maxRetries: 5
        });
      }
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(agentHome, { recursive: true, force: true });
  }
});
