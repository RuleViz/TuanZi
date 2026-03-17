import assert from "node:assert/strict";
import { test } from "node:test";
import { coderSystemPrompt, plannerSystemPrompt, searcherSystemPrompt } from "../agents/prompts";
import type { SkillCatalogItem } from "../core/skill-types";

test("plannerSystemPrompt should use layered xml structure", () => {
  const prompt = plannerSystemPrompt({ workspaceRoot: "/workspace/demo" });

  assert.equal(prompt.includes("<system_prompt>"), true);
  assert.equal(prompt.includes("<base_policy>"), true);
  assert.equal(prompt.includes('<mode_policy mode="planner">'), true);
  assert.equal(prompt.includes("<agent_persona>"), true);
  assert.equal(prompt.includes("<runtime_context>"), true);
  assert.equal(prompt.includes("<tool_policies>"), true);
  assert.equal(prompt.includes("<output_contract>"), true);
  assert.equal(prompt.includes("<runtime_reminders>"), true);
  assert.equal(prompt.includes("<workspace_root>/workspace/demo</workspace_root>"), true);
});

test("searcherSystemPrompt should inject only enabled tool policies", () => {
  const prompt = searcherSystemPrompt({
    workspaceRoot: "/repo",
    enabledTools: ["list_dir", "view_file", "list_dir"]
  });

  assert.equal(prompt.includes('<mode_policy mode="searcher">'), true);
  assert.equal(prompt.includes('<tool name="list_dir">'), true);
  assert.equal(prompt.includes('<tool name="view_file">'), true);
  assert.equal(prompt.includes('<tool name="grep_search">'), false);
  assert.equal(prompt.includes("summary, references, webReferences"), true);
});

test("coderSystemPrompt should keep layered structure and escape dynamic values", () => {
  const skillCatalog: SkillCatalogItem[] = [
    {
      name: "skill<alpha>",
      description: "desc & detail",
      rootDir: "/skills",
      skillDir: "/skills/alpha",
      skillFile: "/skills/alpha/SKILL.md"
    }
  ];

  const prompt = coderSystemPrompt({
    workspaceRoot: "/repo",
    agentName: "Dev <agent>",
    agentPrompt: "Follow <strict> & safe",
    skillCatalog,
    toolInstructions: [
      { name: "run_command", prompt: "Use run_command cautiously." },
      { name: "mcp__web__search", prompt: "Use for new facts." }
    ]
  });

  assert.equal(prompt.includes('<mode_policy mode="coder">'), true);
  assert.equal(prompt.includes("<agent_prompt>"), true);
  assert.equal(prompt.includes("<runtime_context>"), true);
  assert.equal(prompt.includes("<tool_policies>"), true);
  assert.equal(prompt.includes("<output_contract>"), true);
  assert.equal(prompt.includes("<runtime_reminders>"), true);
  assert.equal(prompt.includes("<name>Dev &lt;agent&gt;</name>"), true);
  assert.equal(prompt.includes("Follow &lt;strict&gt; &amp; safe"), true);
  assert.equal(prompt.includes('<skill name="skill&lt;alpha&gt;">desc &amp; detail</skill>'), true);
  assert.equal(prompt.includes('<tool name="mcp__web__search">Use for new facts.</tool>'), true);
});
