import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveActiveTools } from "../core/agent-tooling";

test("resolveActiveTools should apply agent and runtime intersections", () => {
  const selection = resolveActiveTools(
    ["ls", "bash", "unknown_tool"],
    ["ls", "skill_load", "skill_read_resource"]
  );

  assert.deepEqual(selection.activeToolNames, ["ls", "skill_load", "skill_read_resource"]);
  assert.equal(selection.activeTools.map((item) => item.name).join(","), "ls,skill_load,skill_read_resource");
});

test("resolveActiveTools should keep order, dedupe duplicates, and auto-enable internal skill tools", () => {
  const selection = resolveActiveTools(
    ["ls", "ls", "bash", "skill_load"],
    ["ls", "bash", "skill_load", "skill_read_resource"]
  );

  assert.deepEqual(selection.activeToolNames, ["ls", "bash", "skill_load", "skill_read_resource"]);
  assert.equal(
    selection.activeTools.map((item) => item.name).join(","),
    "ls,bash,skill_load,skill_read_resource"
  );
});
