import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigPolicyEngine } from "../core/policy-engine";
import type { PolicySettings } from "../core/types";

const settings: PolicySettings = {
  default: "allow",
  tools: {
    run_command: "ask",
    write_to_file: "ask"
  },
  commandRules: {
    deny: ["/^rm -rf\\b/i", "/^format\\b/i", "git reset --hard"],
    allow: ["echo", "git status"]
  }
};

test("PolicyEngine should deny run_command when matching deny rule", () => {
  const engine = new ConfigPolicyEngine(settings);
  const decision = engine.evaluateTool("run_command", { command: "rm -rf /tmp/demo" });
  assert.equal(decision.decision, "deny");
});

test("PolicyEngine should allow run_command when matching allow rule", () => {
  const engine = new ConfigPolicyEngine(settings);
  const decision = engine.evaluateTool("run_command", { command: "git status" });
  assert.equal(decision.decision, "allow");
});

test("PolicyEngine should fallback to tool policy when no command rule matched", () => {
  const engine = new ConfigPolicyEngine(settings);
  const decision = engine.evaluateTool("run_command", { command: "npm run lint" });
  assert.equal(decision.decision, "ask");
});

test("PolicyEngine regex deny should not block git --pretty=format argument", () => {
  const engine = new ConfigPolicyEngine(settings);
  const decision = engine.evaluateTool("run_command", { command: "git log --pretty=format:%H -n 1" });
  assert.equal(decision.decision, "ask");
});

test("PolicyEngine regex deny should block format command at command head", () => {
  const engine = new ConfigPolicyEngine(settings);
  const decision = engine.evaluateTool("run_command", { command: "format C:" });
  assert.equal(decision.decision, "deny");
});
