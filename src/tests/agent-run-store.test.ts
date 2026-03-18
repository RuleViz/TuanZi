import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentRunStore } from "../core/agent-run-store";

test("AgentRunStore should save/load/clear active run snapshots", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "tuanzi-agent-run-test-"));
  const store = new AgentRunStore(workspaceRoot);

  const saved = await store.saveActiveRun({
    status: "interrupted",
    workspaceRoot,
    modelOverride: "deepseek-chat",
    agentOverride: "default.md",
    task: "finish refactor",
    preparedTask: "finish refactor",
    streamedResponse: "partial output",
    toolCalls: [
      {
        toolName: "read",
        args: { path: "README.md" },
        result: { ok: true, data: { path: "README.md" } },
        timestamp: new Date().toISOString()
      }
    ],
    resumeState: {
      version: 1,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "finish refactor" }
      ],
      toolCalls: [
        {
          name: "read",
          args: { path: "README.md" },
          result: { ok: true, data: { path: "README.md" } }
        }
      ],
      allowedTools: ["read"],
      temperature: 0.15,
      maxTurns: 10,
      nextTurn: 1,
      partialAssistantMessage: {
        role: "assistant",
        content: "partial output"
      }
    }
  });

  assert.equal(saved.status, "interrupted");
  const loaded = await store.loadActiveRun();
  assert(loaded);
  assert.equal(loaded.task, "finish refactor");
  assert.equal(loaded.streamedResponse, "partial output");
  assert.equal(loaded.toolCalls.length, 1);
  assert.equal(loaded.resumeState?.partialAssistantMessage?.content, "partial output");

  await store.clearActiveRun();
  const cleared = await store.loadActiveRun();
  assert.equal(cleared, null);

  await rm(workspaceRoot, { recursive: true, force: true });
});
