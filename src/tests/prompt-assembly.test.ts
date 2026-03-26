import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coderSystemPrompt,
  plannerSystemPrompt,
  searcherSystemPrompt,
  subagentExplorerSystemPrompt
} from "../agents/prompts";
import type { SkillCatalogItem } from "../core/skill-types";

const defaultBudget = {
  total: 120000,
  used: 0,
  remaining: 120000
};

test("plannerSystemPrompt should use layered xml structure", () => {
  const prompt = plannerSystemPrompt({
    workspaceRoot: "/workspace/demo",
    enabledTools: ["ls", "glob", "grep", "read"],
    projectContext: "TUANZI.md not found in workspace root.",
    tokenBudget: defaultBudget
  });

  assert.equal(prompt.includes("<system_prompt>"), true);
  assert.equal(prompt.includes("<base_policy>"), true);
  assert.equal(prompt.includes('<mode_policy mode="planner">'), true);
  assert.equal(prompt.includes("<agent_persona>"), true);
  assert.equal(prompt.includes("<runtime_context>"), true);
  assert.equal(prompt.includes("<project_context>"), true);
  assert.equal(prompt.includes("TUANZI.md not found in workspace root."), true);
  assert.equal(prompt.includes("<tool_policies>"), true);
  assert.equal(prompt.includes("<output_contract>"), true);
  assert.equal(prompt.includes("<runtime_reminders>"), true);
  assert.equal(prompt.includes("<token_budget>"), true);
  assert.equal(prompt.includes("<budget:token_budget>120000</budget:token_budget>"), true);
  assert.equal(prompt.includes("<system_warning>Token usage: 0/120000; 120000 remaining</system_warning>"), true);
  assert.equal(prompt.includes("<workspace_root>/workspace/demo</workspace_root>"), true);
});

test("searcherSystemPrompt should inject only enabled tool policies", () => {
  const prompt = searcherSystemPrompt({
    workspaceRoot: "/repo",
    enabledTools: ["ls", "read", "ls"],
    projectContext: "Project context",
    tokenBudget: defaultBudget
  });

  assert.equal(prompt.includes('<mode_policy mode="searcher">'), true);
  assert.equal(prompt.includes('<tool name="ls">'), true);
  assert.equal(prompt.includes('<tool name="read">'), true);
  assert.equal(prompt.includes('<tool name="grep">'), false);
  assert.equal(prompt.includes("summary, references, webReferences"), true);
  assert.equal(prompt.includes("<project_context>"), true);
  assert.equal(prompt.includes("<token_budget>"), true);
  assert.equal(
    prompt.includes("Recommended exploration workflow: ls -> glob -> grep -> read; adapt as needed for the task."),
    true
  );
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
    projectContext: "<project> & context",
    tokenBudget: defaultBudget,
    toolInstructions: [
      { name: "bash", prompt: "Use bash cautiously." },
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
  assert.equal(prompt.includes("&lt;project&gt; &amp; context"), true);
  assert.equal(prompt.includes("<token_budget>"), true);
  assert.equal(prompt.includes("<budget:token_budget>120000</budget:token_budget>"), true);
  assert.equal(prompt.includes("<system_warning>Token usage: 0/120000; 120000 remaining</system_warning>"), true);
  assert.equal(prompt.includes("Recommended workflow: ls -> glob -> grep -> read before edit/write"), true);
  assert.equal(prompt.includes("call skill_list first to refresh"), true);
  assert.equal(prompt.includes("prefer names[] for multiple skills"), true);
});

test("subagentExplorerSystemPrompt should include project context and token budget", () => {
  const prompt = subagentExplorerSystemPrompt({
    workspaceRoot: "/repo",
    enabledTools: ["ls", "read"],
    projectContext: "Subagent context",
    tokenBudget: defaultBudget
  });

  assert.equal(prompt.includes('<mode_policy mode="subagent_explorer">'), true);
  assert.equal(prompt.includes("<project_context>"), true);
  assert.equal(prompt.includes("Subagent context"), true);
  assert.equal(prompt.includes("<token_budget>"), true);
  assert.equal(prompt.includes("<budget:token_budget>120000</budget:token_budget>"), true);
});
