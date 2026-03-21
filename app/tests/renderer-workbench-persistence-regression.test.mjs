import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(process.cwd(), "src", "renderer", "src", "features", "workbench", "workbench-feature.ts"),
  "utf8"
);

test("workbench feature defines a dedicated local storage key", () => {
  assert.match(source, /const\s+WORKBENCH_STORAGE_KEY\s*=\s*"tuanzi\.desktop\.workbench\.v1"/);
});

test("workbench feature hydrates and persists session workbench state", () => {
  assert.match(source, /localStorage\.getItem\(WORKBENCH_STORAGE_KEY\)/);
  assert.match(source, /localStorage\.setItem\(WORKBENCH_STORAGE_KEY,\s*JSON\.stringify\(/);
  assert.match(source, /function\s+hydrateSessionWorkbenchFromStorage\(/);
  assert.match(source, /hydrateSessionWorkbenchFromStorage\(\);/);
});

test("workbench updates from task and file streams are persisted", () => {
  assert.match(source, /input\.api\.onTasks\([\s\S]*?schedulePersistSessionWorkbench\(\);/);
  assert.match(source, /input\.api\.onModifiedFiles\([\s\S]*?schedulePersistSessionWorkbench\(\);/);
  assert.match(source, /function\s+resetSessionWorkbench\([\s\S]*?schedulePersistSessionWorkbench\(\);/);
});
