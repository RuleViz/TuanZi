import assert from "node:assert/strict";
import { test } from "node:test";
import type { GlobalSkillsConfig } from "../core/agent-store";
import { resolveActiveTools } from "../core/agent-tooling";

const allEnabled: GlobalSkillsConfig = {
  file_system: true,
  execute_command: true,
  web_search: true
};

test("resolveActiveTools should apply global and agent intersections", () => {
  const selection = resolveActiveTools(
    ["list_dir", "run_command", "search_web", "unknown_tool"],
    {
      file_system: true,
      execute_command: false,
      web_search: false
    },
    ["list_dir", "run_command", "search_web"]
  );

  assert.deepEqual(selection.activeToolNames, ["list_dir"]);
  assert.equal(selection.activeTools.length, 1);
  assert.equal(selection.activeTools[0].name, "list_dir");
});

test("resolveActiveTools should keep agent-defined order and remove duplicates", () => {
  const selection = resolveActiveTools(
    ["search_web", "list_dir", "search_web", "run_command"],
    allEnabled,
    ["list_dir", "run_command", "search_web"]
  );

  assert.deepEqual(selection.activeToolNames, ["search_web", "list_dir", "run_command"]);
  assert.equal(selection.activeTools.map((item) => item.name).join(","), "search_web,list_dir,run_command");
});
