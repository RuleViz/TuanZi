import assert from "node:assert/strict";
import test from "node:test";

import type { AppChatResumeSnapshot } from "../chat-resume-store";
import { createRunChatTask } from "./chat-task-service";
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
    checkpointId: "checkpoint-1",
    resumeState: null
  });

  assert.equal(snapshot.streamedText, longText);
  assert.equal(snapshot.streamedThinking, longThinking);
  assert.equal(snapshot.toolCalls.length, toolCalls.length);
  assert.deepEqual(snapshot.toolCalls[24], toolCalls[24]);
  assert.equal(snapshot.checkpointId, "checkpoint-1");
});

test("createRunChatTask returns checkpointId for interrupted tasks", async () => {
  let savedSnapshot: AppChatResumeSnapshot | null = null;
  const appendedTurns: Array<{ checkpointId: string | null; interrupted: boolean }> = [];
  const sessionState = {
    version: 1 as const,
    workspace: "E:/project",
    workspaceHash: "workspace-hash",
    sessionId: "session-1",
    nextSeq: 1,
    lastCompactedSeq: 0,
    modelSnapshot: null,
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-20T00:00:00.000Z"
  };

  const runChatTask = createRunChatTask({
    activeTasks: new Map(),
    chatResumeStore: {
      save: async (snapshot: AppChatResumeSnapshot) => {
        savedSnapshot = snapshot;
        return 1;
      },
      load: () => savedSnapshot,
      clear: async () => {
        savedSnapshot = null;
      }
    } as any,
    conversationMemoryStore: {
      getSessionState: async () => sessionState,
      saveSessionState: async () => {
        return;
      },
      appendTurn: async (record: { checkpointId: string | null; interrupted: boolean }) => {
        appendedTurns.push({
          checkpointId: record.checkpointId,
          interrupted: record.interrupted
        });
      },
      resolveWorkspaceHash: () => "workspace-hash",
      getSummary: async () => null,
      listTurns: async () => []
    } as any,
    loadCoreModules: () => ({
      loadRuntimeConfig: () => ({
        agentBackend: {
          config: {
            activeProviderId: "",
            providers: []
          }
        },
        agentSettings: {
          modelRequest: {
            thinking: {}
          }
        }
      }),
      createToolRuntime: () => ({
        registry: {
          getToolDefinitions: () => []
        },
        toolContext: {},
        dispose: async () => {
          return;
        }
      }),
      createOrchestrator: () => ({
        run: async (_input: unknown, hooks?: { onAssistantTextDelta?: (delta: string) => void }) => {
          hooks?.onAssistantTextDelta?.("partial");
          const error = new Error("Interrupted by user");
          error.name = "AbortError";
          throw error;
        }
      }),
      createSubagentBridge: () => null
    }),
    normalizeOptionalString: (input: unknown) => {
      if (typeof input !== "string") {
        return null;
      }
      const trimmed = input.trim();
      return trimmed ? trimmed : null;
    },
    toErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    closePerfLog: () => {
      return;
    },
    isShutdownDrainInProgress: () => false,
    isShutdownDrainCompleted: () => false,
    snapshotFlushIntervalMs: 1,
    snapshotMaxStreamChars: 24000,
    snapshotMaxToolCalls: 80,
    maxChatImageCount: 1,
    maxChatImageBytes: 8 * 1024 * 1024,
    terminalManager: {
      executeCommand: async () => ({
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: ""
      })
    } as any,
    createTurnCheckpoint: async () => "checkpoint-1"
  });

  const result = await runChatTask(
    {
      send: () => {
        return true;
      }
    } as any,
    {
      taskId: "task-1",
      sessionId: "session-1",
      message: "hello",
      workspace: "E:/project",
      thinking: false,
      planMode: false
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.interrupted, true);
  assert.equal(result.checkpointId, "checkpoint-1");
  assert.equal(result.resumeSnapshot?.streamedText, "partial");
  assert.equal(result.resumeSnapshot?.checkpointId, "checkpoint-1");
  assert.deepEqual(appendedTurns, [{ checkpointId: "checkpoint-1", interrupted: true }]);
});
