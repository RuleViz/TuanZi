import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ChatSessionStore } from "../tui/session-store";

test("ChatSessionStore should save/load/list/drop snapshots", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "tuanzi-session-test-"));
  const store = new ChatSessionStore(workspaceRoot);

  const saved = await store.save(
    {
      workspaceRoot,
      modelOverride: "deepseek-chat",
      agentOverride: "default.md",
      history: [
        {
          id: "1",
          userMessage: "hello",
          assistantMessage: "world",
          toolCalls: [],
          createdAt: new Date().toISOString()
        }
      ],
      usage: {
        inputChars: 5,
        outputChars: 5,
        toolCalls: 0
      }
    },
    "demo checkpoint"
  );

  assert.equal(saved.name, "demo_checkpoint");

  const list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "demo_checkpoint");

  const loaded = await store.load("demo checkpoint");
  assert.equal(loaded.modelOverride, "deepseek-chat");
  assert.equal(loaded.agentOverride, "default.md");
  assert.equal(loaded.history.length, 1);
  assert.equal(loaded.history[0].assistantMessage, "world");

  await store.drop("demo checkpoint");
  const listAfterDrop = await store.list();
  assert.equal(listAfterDrop.length, 0);

  await rm(workspaceRoot, { recursive: true, force: true });
});


test("ChatSessionStore should persist active turn snapshots", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "tuanzi-active-turn-test-"));
  const store = new ChatSessionStore(workspaceRoot);

  const saved = await store.saveActiveTurn({
    status: "interrupted",
    workspaceRoot,
    modelOverride: "deepseek-chat",
    agentOverride: "default.md",
    userMessage: "continue editing",
    preparedTask: "Task:\ncontinue editing",
    history: [],
    usage: {
      inputChars: 16,
      outputChars: 8,
      toolCalls: 1
    },
    resumeState: {
      version: 1,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "continue editing" }
      ],
      toolCalls: [
        {
          name: "view_file",
          args: { path: "README.md" },
          result: { ok: true, data: { path: "README.md" } }
        }
      ],
      allowedTools: ["view_file"],
      temperature: 0.15,
      maxTurns: 8,
      nextTurn: 1,
      partialAssistantMessage: {
        role: "assistant",
        content: "partial answer"
      }
    }
  });

  assert.equal(saved.status, "interrupted");
  assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const loaded = await store.loadActiveTurn();
  assert(loaded);
  assert.equal(loaded.status, "interrupted");
  assert.equal(loaded.userMessage, "continue editing");
  assert.equal(loaded.resumeState?.toolCalls.length, 1);
  assert.equal(loaded.resumeState?.partialAssistantMessage?.content, "partial answer");

  await store.clearActiveTurn();
  const cleared = await store.loadActiveTurn();
  assert.equal(cleared, null);

  await rm(workspaceRoot, { recursive: true, force: true });
});
