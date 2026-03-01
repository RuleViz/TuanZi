import assert from "node:assert/strict";
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

test("should default to Qwen base/model when QWEN_API_KEY is set", () => {
  withEnv(
    {
      MYCODER_API_KEY: null,
      MYCODER_API_BASE_URL: null,
      MYCODER_MODEL: null,
      MYCODER_PLANNER_MODEL: null,
      MYCODER_SEARCH_MODEL: null,
      MYCODER_CODER_MODEL: null,
      QWEN_API_KEY: "qwen-demo-key",
      DEEPSEEK_API_KEY: null
    },
    () => {
      const config = loadRuntimeConfig({ workspaceRoot: process.cwd(), approvalMode: "manual" });
      assert.equal(config.model.apiKey, "qwen-demo-key");
      assert.equal(config.model.baseUrl, "https://coding.dashscope.aliyuncs.com/v1");
      assert.equal(config.model.plannerModel, "qwen3.5-plus");
      assert.equal(config.model.searchModel, "qwen3.5-plus");
      assert.equal(config.model.coderModel, "qwen3.5-plus");
    }
  );
});

test("should keep MYCODER_API_KEY as highest-priority key source", () => {
  withEnv(
    {
      MYCODER_API_KEY: "mycoder-key",
      MYCODER_API_BASE_URL: null,
      MYCODER_MODEL: null,
      QWEN_API_KEY: "qwen-demo-key",
      DEEPSEEK_API_KEY: "deepseek-demo-key"
    },
    () => {
      const config = loadRuntimeConfig({ workspaceRoot: process.cwd(), approvalMode: "manual" });
      assert.equal(config.model.apiKey, "mycoder-key");
      assert.equal(config.model.baseUrl, "https://api.openai.com/v1");
      assert.equal(config.model.plannerModel, null);
      assert.equal(config.model.searchModel, null);
      assert.equal(config.model.coderModel, null);
    }
  );
});

