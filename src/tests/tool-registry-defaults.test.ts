import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultTools } from "../tools";

test("createDefaultTools should expose core workflow tools and exclude removed tools", () => {
  const names = createDefaultTools().map((tool) => tool.definition.name);

  const expectedCoreTools = [
    "ls",
    "glob",
    "grep",
    "read",
    "edit",
    "write",
    "bash",
    "spawn_subagent",
    "wait_subagents",
    "list_subagents"
  ];
  for (const name of expectedCoreTools) {
    assert.equal(names.includes(name), true, `Expected default tools to include ${name}`);
  }

  assert.equal(names.includes("checkpoint"), false);
  assert.equal(names.includes("codebase_search"), false);
});
