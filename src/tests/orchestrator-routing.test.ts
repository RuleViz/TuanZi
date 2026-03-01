import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldUseDirectAnswer } from "../agents/orchestrator";
import type { RoutingSettings } from "../core/types";

const routing: RoutingSettings = {
  enableDirectMode: true,
  defaultEnablePlanMode: false,
  directIntentPatterns: ["introduce", "explain", "how", "what"]
};

test("should route greeting/explanation requests to direct mode", () => {
  assert.equal(shouldUseDirectAnswer("please explain TypeScript", routing), true);
  assert.equal(shouldUseDirectAnswer("What is TypeScript?", routing), true);
});

test("should route code-edit requests to workflow mode", () => {
  assert.equal(shouldUseDirectAnswer("please modify src/config.ts and fix bug", routing), false);
  assert.equal(shouldUseDirectAnswer("run command npm test then patch file", routing), false);
});

test("should disable direct mode when routing config disabled", () => {
  assert.equal(
    shouldUseDirectAnswer("please explain TypeScript", {
      ...routing,
      enableDirectMode: false
    }),
    false
  );
});
