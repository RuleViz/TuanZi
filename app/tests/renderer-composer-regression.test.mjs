import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync(join(process.cwd(), "src", "renderer", "index.html"), "utf8");
const stateSource = readFileSync(join(process.cwd(), "src", "renderer", "src", "app", "state.ts"), "utf8");
const initEventsSource = readFileSync(join(process.cwd(), "src", "renderer", "src", "app", "init-events.ts"), "utf8");
const runtimeSource = readFileSync(join(process.cwd(), "src", "renderer", "src", "app", "renderer-runtime.ts"), "utf8");
const imageAttachSource = readFileSync(
  join(process.cwd(), "src", "renderer", "src", "features", "chat", "image-attach.ts"),
  "utf8"
);

test("composer toolbar removes thinking and workspace shortcut buttons", () => {
  assert.doesNotMatch(html, /id="thinkingBtn"/);
  assert.doesNotMatch(html, /id="selectWorkspaceBtn"/);
});

test("workspace label remains in top-left sidebar", () => {
  assert.match(html, /id="workspaceLabel"/);
});

test("thinking mode defaults to enabled and is not toggled by a button", () => {
  assert.match(stateSource, /isThinking:\s*true,/);
  assert.doesNotMatch(initEventsSource, /input\.state\.isThinking\s*=\s*!input\.state\.isThinking/);
});

test("image button visibility follows active model image capability", () => {
  assert.match(runtimeSource, /isActiveModelImageUploadSupported/);
  assert.match(runtimeSource, /attachImageBtn\.style\.display\s*=\s*supportsImageUpload\s*\?\s*""\s*:\s*"none"/);
});

test("image attachment rejects unsupported models before reading file", () => {
  assert.match(imageAttachSource, /isImageUploadSupported:\s*\(\)\s*=>\s*boolean/);
  assert.match(imageAttachSource, /if\s*\(!input\.isImageUploadSupported\(\)\)/);
  assert.match(imageAttachSource, /Current model does not support image uploads/);
});
