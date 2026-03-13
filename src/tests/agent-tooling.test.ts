import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveActiveTools } from "../core/agent-tooling";

test("resolveActiveTools should apply agent and runtime intersections", () => {
  const selection = resolveActiveTools(
    ["list_dir", "run_command", "unknown_tool"],
    ["list_dir", "skill_load", "skill_read_resource"]
  );

  assert.deepEqual(selection.activeToolNames, ["list_dir", "skill_load", "skill_read_resource"]);
  assert.equal(selection.activeTools.map((item) => item.name).join(","), "list_dir,skill_load,skill_read_resource");
});

test("resolveActiveTools should keep order, dedupe duplicates, and auto-enable internal skill tools", () => {
  const selection = resolveActiveTools(
    ["list_dir", "list_dir", "run_command", "skill_load"],
    ["list_dir", "run_command", "skill_load", "skill_read_resource"]
  );

  assert.deepEqual(selection.activeToolNames, ["list_dir", "run_command", "skill_load", "skill_read_resource"]);
  assert.equal(
    selection.activeTools.map((item) => item.name).join(","),
    "list_dir,run_command,skill_load,skill_read_resource"
  );
});
