import assert from "node:assert/strict";
import test from "node:test";

import { buildPersistedResumeSnapshot } from "./chat-task-snapshot.js";

test("buildPersistedResumeSnapshot should keep full streamed text, thinking, and tool calls", () => {
  const longText = "assistant-".repeat(900);
  const longThinking = "thinking-".repeat(900);
  const toolCalls = Array.from({ length: 25 }, (_, index) => ({
    id: `tool-${index}`,
    name: "bash",
    args: { command: `echo ${index}` },
    result: { ok: true, data: { stdout: "x".repeat(300) } }
  }));

  const snapshot = buildPersistedResumeSnapshot({
    taskId: "task-1",
    sessionId: "session-1",
    workspace: "E:/project/Nice/MyCoderAgent",
    message: "hello",
    agentId: null,
    thinkingEnabled: true,
    streamedText: longText,
    streamedThinking: longThinking,
    toolCalls,
    resumeState: null
  });

  assert.equal(snapshot.streamedText, longText);
  assert.equal(snapshot.streamedThinking, longThinking);
  assert.equal(snapshot.toolCalls.length, toolCalls.length);
  assert.deepEqual(snapshot.toolCalls[24], toolCalls[24]);
});
