import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConversationContext } from "../agents/orchestrator";

test("buildConversationContext should include user and assistant content", () => {
  const context = buildConversationContext([
    { user: "u1", assistant: "a1" },
    { user: "u2", assistant: "a2" }
  ]);
  assert.match(context, /Turn 1:/);
  assert.match(context, /User:\nu1/);
  assert.match(context, /Assistant:\na2/);
});

test("buildConversationContext should respect maxTurns and maxChars", () => {
  const context = buildConversationContext(
    [
      { user: "first", assistant: "x" },
      { user: "second", assistant: "y" },
      { user: "third", assistant: "z" }
    ],
    { maxTurns: 2, maxChars: 40 }
  );
  assert.equal(context.includes("first"), false);
  assert.equal(context.length <= 40, true);
});
