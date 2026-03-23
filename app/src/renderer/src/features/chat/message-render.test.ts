import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExecContentState,
  formatToolArgsText,
  formatToolResultText
} from "./message-render.js";

test("formatToolArgsText should keep full serialized args", () => {
  const payload = { text: "A".repeat(1600) };
  const formatted = formatToolArgsText(payload);

  assert.match(formatted, /A{1600}/);
  assert.doesNotMatch(formatted, /\.\.\.$/);
});

test("formatToolResultText should keep full MCP text blocks", () => {
  const longText = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n");
  const formatted = formatToolResultText({
    ok: true,
    data: {
      content: [{ type: "text", text: longText }]
    }
  });

  assert.equal(formatted, longText);
  assert.doesNotMatch(formatted, /truncated/i);
});

test("buildExecContentState should keep content hidden while collapsed", () => {
  const fullText = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n");

  const state = buildExecContentState(fullText);

  assert.equal(state.collapsedText, "");
  assert.equal(state.expandedText, fullText);
});

test("buildExecContentState should also keep short content hidden while collapsed", () => {
  const fullText = Array.from({ length: 3 }, (_, index) => `line-${index + 1}`).join("\n");

  const state = buildExecContentState(fullText);

  assert.equal(state.collapsedText, "");
  assert.equal(state.expandedText, fullText);
});
