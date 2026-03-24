import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConversationMemoryAssembler } from "./conversation-memory-assembler.js";
import { ConversationMemoryStore } from "./conversation-memory-store.js";

test("assembler should format error turns with [ERROR] tag and error message", async () => {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "conversation-assembler-err-"));
  const workspace = path.join(baseDir, "workspace");
  const sessionId = "session-err";

  try {
    const store = new ConversationMemoryStore(baseDir);
    await store.getSessionState(workspace, sessionId);

    await store.appendTurn({
      version: 1,
      workspace,
      workspaceHash: store.resolveWorkspaceHash(workspace),
      sessionId,
      seq: 1,
      turnId: "turn-err",
      taskId: "task-err",
      turnIndex: 1,
      user: "do something complex",
      assistant: "partial response before error",
      thinkingSummary: "",
      toolCalls: [
        {
          toolName: "bash",
          args: { command: "echo hello" },
          result: { ok: true, data: { stdout: "hello" } },
          timestamp: "2026-03-20T00:00:00.000Z"
        }
      ],
      checkpointId: null,
      interrupted: true,
      error: "Model request limit reached (429 Too Many Requests)",
      createdAt: "2026-03-20T00:00:00.000Z"
    });

    const assembler = new ConversationMemoryAssembler(store);
    const assembled = await assembler.assembleContext({
      workspace,
      sessionId,
      currentUserMessage: "continue"
    });

    assert.match(assembled.contextText, /\[INTERRUPTED\]/);
    assert.match(assembled.contextText, /\[ERROR\]/);
    assert.match(assembled.contextText, /Error: Model request limit reached/);
    assert.match(assembled.contextText, /partial response before error/);
    assert.match(assembled.contextText, /bash/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("assembler should include full raw turns even after compaction state advances", async () => {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "conversation-assembler-"));
  const workspace = path.join(baseDir, "workspace");
  const sessionId = "session-1";
  const longArgs = "A".repeat(260);
  const longResult = "R".repeat(420);
  const longThinking = "T".repeat(1200);

  try {
    const store = new ConversationMemoryStore(baseDir);
    const state = await store.getSessionState(workspace, sessionId);
    state.lastCompactedSeq = 999;
    await store.saveSessionState(state);

    await store.appendTurn({
      version: 1,
      workspace,
      workspaceHash: store.resolveWorkspaceHash(workspace),
      sessionId,
      seq: 1,
      turnId: "turn-1",
      taskId: "task-1",
      turnIndex: 1,
      user: "show me the full tool history",
      assistant: "here it is",
      thinkingSummary: longThinking,
      toolCalls: [
        {
          toolName: "bash",
          args: { command: longArgs },
          result: {
            ok: true,
            data: { stdout: longResult }
          },
          timestamp: "2026-03-20T00:00:00.000Z"
        }
      ],
      checkpointId: null,
      interrupted: false,
      createdAt: "2026-03-20T00:00:00.000Z"
    });

    const assembler = new ConversationMemoryAssembler(store);
    const assembled = await assembler.assembleContext({
      workspace,
      sessionId,
      currentUserMessage: "current input"
    });

    assert.equal(assembled.rawTurnsSinceCompaction.length, 1);
    assert.match(assembled.contextText, /Turn #1/);
    assert.match(assembled.contextText, new RegExp(longArgs));
    assert.match(assembled.contextText, new RegExp(longResult));
    assert.match(assembled.contextText, new RegExp(longThinking));
    assert.doesNotMatch(assembled.contextText, /\.\.\.\(truncated\)/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
