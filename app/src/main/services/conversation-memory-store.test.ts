import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConversationMemoryStore } from "./conversation-memory-store.js";

test("rollbackToCheckpoint removes turns from the checkpoint onward and resets invalid summary state", async () => {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "conversation-memory-store-"));
  const workspace = path.join(baseDir, "workspace");
  const sessionId = "session-1";

  try {
    const store = new ConversationMemoryStore(baseDir);
    const workspaceHash = store.resolveWorkspaceHash(workspace);
    const state = await store.getSessionState(workspace, sessionId);
    state.nextSeq = 4;
    state.lastCompactedSeq = 3;
    await store.saveSessionState(state);

    for (const turn of [
      { seq: 1, checkpointId: "checkpoint-1", user: "one" },
      { seq: 2, checkpointId: "checkpoint-2", user: "two" },
      { seq: 3, checkpointId: "checkpoint-3", user: "three" }
    ]) {
      await store.appendTurn({
        version: 1,
        workspace,
        workspaceHash,
        sessionId,
        seq: turn.seq,
        turnId: `turn-${turn.seq}`,
        taskId: `task-${turn.seq}`,
        turnIndex: turn.seq,
        user: turn.user,
        assistant: `assistant-${turn.seq}`,
        thinkingSummary: "",
        toolCalls: [],
        checkpointId: turn.checkpointId,
        interrupted: false,
        createdAt: "2026-03-20T00:00:00.000Z"
      });
    }

    await store.saveSummary({
      version: 1,
      workspace,
      workspaceHash,
      sessionId,
      fromSeq: 1,
      toSeq: 3,
      title: "summary",
      summary: "summary text",
      keyPoints: ["a"],
      openQuestions: [],
      updatedAt: "2026-03-20T00:00:00.000Z",
      source: "fallback"
    });

    const rolledBack = await (store as unknown as {
      rollbackToCheckpoint: (workspace: string, sessionId: string, checkpointId: string) => Promise<boolean>;
    }).rollbackToCheckpoint(workspace, sessionId, "checkpoint-2");

    assert.equal(rolledBack, true);
    assert.deepEqual(
      (await store.listTurns(workspace, sessionId)).map((turn) => ({
        seq: turn.seq,
        checkpointId: turn.checkpointId
      })),
      [{ seq: 1, checkpointId: "checkpoint-1" }]
    );

    const nextState = await store.getSessionState(workspace, sessionId);
    assert.equal(nextState.nextSeq, 2);
    assert.equal(nextState.lastCompactedSeq, 0);
    assert.equal(await store.getSummary(workspace, sessionId), null);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
