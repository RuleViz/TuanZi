import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSlashCommand } from "../tui/slash-commands";

test("parseSlashCommand should parse command name and args", () => {
  const parsed = parseSlashCommand("/model deepseek-chat");
  assert.deepEqual(parsed, {
    raw: "/model deepseek-chat",
    name: "model",
    args: ["deepseek-chat"]
  });
});

test("parseSlashCommand should support quoted args", () => {
  const parsed = parseSlashCommand('/checkpoint save "release prep"');
  assert.deepEqual(parsed, {
    raw: '/checkpoint save "release prep"',
    name: "checkpoint",
    args: ["save", "release prep"]
  });
});

test("parseSlashCommand should ignore non slash input", () => {
  assert.equal(parseSlashCommand("hello"), null);
});
