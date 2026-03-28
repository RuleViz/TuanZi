import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ChatMessage } from "../agents/model-types";
import type { ToolLoopResumeState } from "../agents/react-tool-agent";
import { SubagentSessionStore } from "../agents/subagent-session-store";

function createResumeState(): ToolLoopResumeState {
  return {
    version: 1,
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "task" }
    ],
    toolCalls: [],
    allowedTools: ["read"],
    temperature: 0.1,
    maxTurns: 4,
    nextTurn: 1,
    partialAssistantMessage: null
  };
}

test("SubagentSessionStore should save and load a subagent snapshot", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mycoderagent-subagent-store-"));
  const store = new SubagentSessionStore(workspaceRoot);
  const messages: ChatMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "task" }
  ];
  const resumeState = createResumeState();

  try {
    await store.save({
      sessionId: "session-1",
      agentId: "subagent-1",
      task: "search auth flow",
      context: "focus on renderer",
      conversationSnapshot: {
        messages,
        resumeState
      }
    });

    const loaded = await store.load({
      sessionId: "session-1",
      agentId: "subagent-1"
    });

    assert.equal(loaded.task, "search auth flow");
    assert.equal(loaded.context, "focus on renderer");
    assert.deepEqual(loaded.conversationSnapshot.messages, messages);
    assert.deepEqual(loaded.conversationSnapshot.resumeState, resumeState);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("SubagentSessionStore should require an explicit sessionId", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mycoderagent-subagent-store-"));
  const store = new SubagentSessionStore(workspaceRoot);

  try {
    await assert.rejects(
      () =>
        store.save({
          sessionId: "",
          agentId: "subagent-1",
          task: "search auth flow",
          context: "",
          conversationSnapshot: {
            messages: [],
            resumeState: createResumeState()
          }
        }),
      /sessionId/i
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
