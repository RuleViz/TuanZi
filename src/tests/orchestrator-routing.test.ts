import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldUseDirectAnswer } from "../agents/orchestrator";
import type { RoutingSettings } from "../core/types";

const routing: RoutingSettings = {
  enableDirectMode: true,
  directIntentPatterns: ["介绍", "解释", "是什么", "how", "what"]
};

test("should route greeting/explanation requests to direct mode", () => {
  assert.equal(shouldUseDirectAnswer("请介绍一下你自己", routing), true);
  assert.equal(shouldUseDirectAnswer("What is TypeScript?", routing), true);
});

test("should route code-edit requests to workflow mode", () => {
  assert.equal(shouldUseDirectAnswer("请修改 src/config.ts 并修复 bug", routing), false);
  assert.equal(shouldUseDirectAnswer("run command npm test then patch file", routing), false);
});

test("should disable direct mode when routing config disabled", () => {
  assert.equal(
    shouldUseDirectAnswer("请介绍一下你自己", {
      ...routing,
      enableDirectMode: false
    }),
    false
  );
});

