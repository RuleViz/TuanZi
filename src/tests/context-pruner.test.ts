import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "../agents/model-types";
import { pruneToolOutputs } from "../agents/context-pruner";

function toolMessage(id: string, name: string, content: string): ChatMessage {
  return {
    role: "tool",
    tool_call_id: id,
    name,
    content
  };
}

test("pruneToolOutputs should keep recent tool outputs and prune older ones", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    toolMessage("call-1", "read", "a".repeat(160)),
    toolMessage("call-2", "read", "b".repeat(160)),
    toolMessage("call-3", "read", "c".repeat(160))
  ];

  pruneToolOutputs(messages, {
    protectRecentTokens: 80,
    pruneMinimumTokens: 20,
    pruneStrategy: "truncate"
  });

  assert.equal(messages[2].role, "tool");
  assert.equal(messages[2].content, "[Tool output pruned - 40 tokens removed]");
  assert.equal(messages[3].content, "b".repeat(160));
  assert.equal(messages[4].content, "c".repeat(160));
  assert.equal(messages[0].content, "sys");
});

test("pruneToolOutputs should not prune when removable tokens are below pruneMinimumTokens", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    toolMessage("call-1", "read", "a".repeat(160)),
    toolMessage("call-2", "read", "b".repeat(160))
  ];

  pruneToolOutputs(messages, {
    protectRecentTokens: 40,
    pruneMinimumTokens: 60,
    pruneStrategy: "truncate"
  });

  assert.equal(messages[1].content, "a".repeat(160));
  assert.equal(messages[2].content, "b".repeat(160));
});

test("pruneToolOutputs should treat summarize as truncate for now", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    toolMessage("call-1", "read", "a".repeat(160)),
    toolMessage("call-2", "read", "b".repeat(160)),
    toolMessage("call-3", "read", "c".repeat(160))
  ];

  pruneToolOutputs(messages, {
    protectRecentTokens: 80,
    pruneMinimumTokens: 20,
    pruneStrategy: "summarize"
  });

  assert.equal(messages[1].content, "[Tool output pruned - 40 tokens removed]");
  assert.equal(messages[2].content, "b".repeat(160));
  assert.equal(messages[3].content, "c".repeat(160));
});
