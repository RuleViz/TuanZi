import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { assertInsideWorkspace, ensureAbsolutePath, resolveSafePath } from "../core/path-utils";

const workspaceRoot = path.resolve(process.cwd(), "tmp-workspace");

test("resolveSafePath should resolve relative paths against workspace root", () => {
  const resolvedDot = resolveSafePath(".", workspaceRoot);
  const resolvedNested = resolveSafePath("./src/index.ts", workspaceRoot);

  assert.equal(resolvedDot, path.resolve(workspaceRoot));
  assert.equal(resolvedNested, path.resolve(workspaceRoot, "./src/index.ts"));
});

test("resolveSafePath should preserve absolute path resolution", () => {
  const absolutePath = path.resolve(workspaceRoot, "README.md");
  const resolved = resolveSafePath(absolutePath, workspaceRoot);
  assert.equal(resolved, absolutePath);
});

test("ensureAbsolutePath should still reject relative paths", () => {
  assert.throws(() => ensureAbsolutePath("./src"), /must be an absolute path/i);
});

test("assertInsideWorkspace should throw actionable message for outside path", () => {
  const outsidePath = path.resolve(workspaceRoot, "..", "outside-dir", "a.txt");
  assert.throws(
    () => assertInsideWorkspace(outsidePath, workspaceRoot),
    /outside workspace root[\s\S]*relative path like '\.' or '\.\/src'/i
  );
});
