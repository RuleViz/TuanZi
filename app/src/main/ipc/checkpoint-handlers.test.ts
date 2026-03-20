import assert from "node:assert/strict";
import test from "node:test";

import { handleCheckpointUndo } from "./checkpoint-handlers";

test("handleCheckpointUndo clears resume snapshot after a successful restore", async () => {
  let cleared = 0;
  const rollbackCalls: Array<{ workspace: string; sessionId: string; checkpointId: string }> = [];

  const result = await handleCheckpointUndo(
    {
      normalizeOptionalString: (input: unknown) => (typeof input === "string" && input.trim() ? input.trim() : null),
      toErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
      getCheckpointManager: () =>
        ({
          restore: async () => ({ restoredFiles: 2, removedFiles: 1 })
        }) as any,
      rollbackConversationMemoryToCheckpoint: async (workspace: string, sessionId: string, checkpointId: string) => {
        rollbackCalls.push({ workspace, sessionId, checkpointId });
        return true;
      },
      clearResumeSnapshot: async () => {
        cleared += 1;
      }
    },
    {
      workspace: "E:/project",
      sessionId: "session-1",
      checkpointId: "checkpoint-1"
    }
  );

  assert.deepEqual(result, { ok: true, restoredFiles: 2, removedFiles: 1 });
  assert.equal(cleared, 1);
  assert.deepEqual(rollbackCalls, [
    { workspace: "E:/project", sessionId: "session-1", checkpointId: "checkpoint-1" }
  ]);
});

test("handleCheckpointUndo does not clear resume snapshot when restore fails", async () => {
  let cleared = 0;
  let rollbackCalls = 0;

  const result = await handleCheckpointUndo(
    {
      normalizeOptionalString: (input: unknown) => (typeof input === "string" && input.trim() ? input.trim() : null),
      toErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
      getCheckpointManager: () =>
        ({
          restore: async () => null
        }) as any,
      rollbackConversationMemoryToCheckpoint: async () => {
        rollbackCalls += 1;
        return true;
      },
      clearResumeSnapshot: async () => {
        cleared += 1;
      }
    },
    {
      workspace: "E:/project",
      sessionId: "session-1",
      checkpointId: "checkpoint-1"
    }
  );

  assert.deepEqual(result, { ok: false, error: "Failed to restore checkpoint" });
  assert.equal(cleared, 0);
  assert.equal(rollbackCalls, 0);
});
