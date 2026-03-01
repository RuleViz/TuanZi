import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConversationContext } from "../agents/orchestrator";

test("buildConversationContext should include user and assistant memory", () => {
  const context = buildConversationContext([
    { user: "Where is config?", assistant: "Check agent.config.json in project root." },
    { user: "Use npm test after patch.", assistant: "Understood, I will run tests." }
  ]);

  assert.match(context, /User: Where is config\?/);
  assert.match(context, /Assistant: Check agent\.config\.json/);
  assert.match(context, /User: Use npm test after patch\./);
});

test("buildConversationContext should keep recent turns when maxTurns is limited", () => {
  const context = buildConversationContext(
    [
      { user: "turn-1", assistant: "a-1" },
      { user: "turn-2", assistant: "a-2" },
      { user: "turn-3", assistant: "a-3" }
    ],
    { maxTurns: 2, maxChars: 2000 }
  );

  assert.equal(context.includes("turn-1"), false);
  assert.equal(context.includes("turn-2"), true);
  assert.equal(context.includes("turn-3"), true);
});

test("buildConversationContext should not truncate long memory by default", () => {
  const longAssistant = "x".repeat(9000);
  const context = buildConversationContext([{ user: "keep all", assistant: longAssistant }]);
  assert.equal(context.includes(longAssistant), true);
});
