import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigPolicyEngine } from "../core/policy-engine";
import type { PolicySettings } from "../core/types";

const settings: PolicySettings = {
  default: "allow",
  tools: {
    bash: "ask",
    write: "ask"
  },
  commandRules: {
    deny: ["/^rm -rf\\b/i", "/^format\\b/i", "git reset --hard"],
    allow: ["echo", "git status"]
  }
};

test("PolicyEngine should deny bash when matching deny rule", () => {
  const engine = new ConfigPolicyEngine(settings);
  const decision = engine.evaluateTool("bash", { command: "rm -rf /tmp/demo" });
  assert.equal(decision.decision, "deny");
});

test("PolicyEngine should allow bash when matching allow rule", () => {
  const engine = new ConfigPolicyEngine(settings);
  const decision = engine.evaluateTool("bash", { command: "git status" });
  assert.equal(decision.decision, "allow");
});

test("PolicyEngine should fallback to tool policy when no command rule matched", () => {
  const engine = new ConfigPolicyEngine(settings);
  const decision = engine.evaluateTool("bash", { command: "npm run lint" });
  assert.equal(decision.decision, "ask");
});

test("PolicyEngine regex deny should not block git --pretty=format argument", () => {
  const engine = new ConfigPolicyEngine(settings);
  const decision = engine.evaluateTool("bash", { command: "git log --pretty=format:%H -n 1" });
  assert.equal(decision.decision, "ask");
});

test("PolicyEngine regex deny should block format command at command head", () => {
  const engine = new ConfigPolicyEngine(settings);
  const decision = engine.evaluateTool("bash", { command: "format C:" });
  assert.equal(decision.decision, "deny");
});
