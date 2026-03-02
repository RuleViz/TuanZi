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
  assert.equal(loaded.history.length, 1);
  assert.equal(loaded.history[0].assistantMessage, "world");

  await store.drop("demo checkpoint");
  const listAfterDrop = await store.list();
  assert.equal(listAfterDrop.length, 0);

  await rm(workspaceRoot, { recursive: true, force: true });
});
