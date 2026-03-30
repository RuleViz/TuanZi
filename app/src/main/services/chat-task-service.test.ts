import assert from "node:assert/strict";
import test from "node:test";

import type { AppChatResumeSnapshot } from "../chat-resume-store";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
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

test("createRunChatTask should send nested subagent result previews through IPC", async () => {
  const sentMessages: Array<{ channel: string; payload: unknown }> = [];
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
      save: async () => 1,
      load: () => null,
      clear: async () => {
        return;
      }
    } as any,
    conversationMemoryStore: {
      getSessionState: async () => sessionState,
      saveSessionState: async () => {
        return;
      },
      appendTurn: async () => {
        return;
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
        run: async () => ({
          summary: "done",
          toolCalls: [],
          changedFiles: [],
          executedCommands: []
        })
      }),
      createSubagentBridge: (_config: unknown, _runtime: unknown, input?: { onSnapshotsChange?: (snapshots: unknown[]) => void }) => {
        input?.onSnapshotsChange?.([
          {
            id: "subagent-1",
            parentTaskId: "task-1",
            kind: "explorer",
            status: "completed",
            task: "find auth files",
            context: "",
            createdAt: "2026-03-28T00:00:00.000Z",
            updatedAt: "2026-03-28T00:00:01.000Z",
            startedAt: "2026-03-28T00:00:00.100Z",
            completedAt: "2026-03-28T00:00:01.000Z",
            result: {
              data: {
                summary: "found auth files",
                references: [{ path: "src/auth.ts", reason: "contains auth flow", confidence: "high" }],
                webReferences: [{ url: "https://example.com/auth", reason: "related design notes" }],
                fullTextPreview: "preview text",
                toolCallPreview: [
                  {
                    id: "call-1",
                    name: "read",
                    args: { path: "src/auth.ts" },
                    result: { ok: true, data: "file content" }
                  }
                ],
                metadata: {
                  toolCalls: [],
                  turnCount: 1,
                  completedAt: "2026-03-28T00:00:01.000Z"
                }
              },
              exitReason: "completed",
              context: {
                messages: [],
                toolCalls: []
              }
            }
          }
        ]);
        return {
          spawn: async () => ({ subagentId: "subagent-1", status: "queued" }),
          resume: async () => ({ subagentId: "subagent-1", status: "queued" }),
          wait: async () => ({ completed: [], pending: [], timedOut: false }),
          list: async () => [],
          dispose: async () => {
            return;
          }
        };
      }
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
    createTurnCheckpoint: async () => null
  });

  await runChatTask(
    {
      send: (channel: string, payload: unknown) => {
        sentMessages.push({ channel, payload });
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

  const snapshotEvent = sentMessages.find((entry) => entry.channel === IPC_CHANNELS.chatSubagentSnapshot);
  assert.ok(snapshotEvent);
  const snapshots = (snapshotEvent!.payload as {
    snapshots: Array<{
      exitReason: string | null;
      error: string | null;
      result: null | {
        summary: string;
        fullTextPreview: string | null;
        toolCallPreview: Array<{ name: string }>;
      };
      summary?: never;
    }>;
  }).snapshots;
  assert.equal(snapshots.length, 1);
  assert.equal("summary" in snapshots[0], false);
  assert.equal(snapshots[0].result?.summary, "found auth files");
  assert.equal(snapshots[0].result?.fullTextPreview, "preview text");
  assert.equal(snapshots[0].result?.toolCallPreview.length, 1);
  assert.equal(snapshots[0].result?.toolCallPreview[0]?.name, "read");
  assert.equal(snapshots[0].exitReason, "completed");
  assert.equal(snapshots[0].error, null);
});

test("createRunChatTask saves error turn and returns resumeSnapshot for non-interruption errors", async () => {
  let savedSnapshot: AppChatResumeSnapshot | null = null;
  const appendedTurns: Array<{ checkpointId: string | null; interrupted: boolean; error?: string | null }> = [];
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
      appendTurn: async (record: { checkpointId: string | null; interrupted: boolean; error?: string | null }) => {
        appendedTurns.push({
          checkpointId: record.checkpointId,
          interrupted: record.interrupted,
          error: record.error
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
          hooks?.onAssistantTextDelta?.("partial error text");
          throw new Error("Model request limit reached");
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
    createTurnCheckpoint: async () => "checkpoint-err"
  });

  const result = await runChatTask(
    {
      send: () => {
        return true;
      }
    } as any,
    {
      taskId: "task-err",
      sessionId: "session-1",
      message: "hello",
      workspace: "E:/project",
      thinking: false,
      planMode: false
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.interrupted, true);
  assert.equal(result.error, "Model request limit reached");
  assert.equal(result.checkpointId, "checkpoint-err");
  assert.equal(appendedTurns.length, 1);
  assert.equal(appendedTurns[0].interrupted, true);
  assert.equal(appendedTurns[0].error, "Model request limit reached");
  assert.equal(appendedTurns[0].checkpointId, "checkpoint-err");
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

test("createRunChatTask passes explicit forcePlanMode and originCheckpointId to orchestrator", async () => {
  const capturedInputs: Array<Record<string, unknown>> = [];
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
      save: async () => 1,
      load: () => null,
      clear: async () => {
        return;
      }
    } as any,
    conversationMemoryStore: {
      getSessionState: async () => sessionState,
      saveSessionState: async () => {
        return;
      },
      appendTurn: async () => {
        return;
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
        run: async (input: Record<string, unknown>) => {
          capturedInputs.push(input);
          return {
            summary: "done",
            toolCalls: [],
            changedFiles: [],
            executedCommands: []
          };
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
    createTurnCheckpoint: async () => "checkpoint-bind"
  });

  const webContents = {
    send: () => true
  } as any;

  await runChatTask(webContents, {
    taskId: "task-direct",
    sessionId: "session-1",
    message: "hello",
    workspace: "E:/project",
    thinking: false,
    planMode: false
  });

  await runChatTask(webContents, {
    taskId: "task-plan",
    sessionId: "session-1",
    message: "hello plan",
    workspace: "E:/project",
    thinking: false,
    planMode: true
  });

  assert.equal(capturedInputs.length, 2);
  assert.equal(capturedInputs[0].forcePlanMode, false);
  assert.equal(capturedInputs[1].forcePlanMode, true);
  assert.equal(capturedInputs[0].originCheckpointId, "checkpoint-bind");
  assert.equal(capturedInputs[1].originCheckpointId, "checkpoint-bind");
});
