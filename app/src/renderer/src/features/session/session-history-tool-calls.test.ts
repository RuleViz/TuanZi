import assert from "node:assert/strict";
import test from "node:test";

import type { ChatSession } from "../../app/state";
import { sendMessage } from "../chat/send-message";
import { refreshResumeSnapshot } from "./resume-sync";
import { createSessionActions } from "./session-actions";
import { createSessionStore } from "./session-store";

function installBrowserStubs(
  sendMessageResult: Record<string, unknown> = {
    ok: true,
    taskId: "task-1",
    summary: "done",
    checkpointId: "checkpoint-1",
    toolCalls: [
      {
        toolName: "read_file",
        args: { path: "README.md" },
        result: { ok: true, data: "hello" },
        timestamp: "2026-03-20T00:00:00.000Z"
      }
    ]
  }
): void {
  const storage = new Map<string, string>();
  const localStorage = {
    getItem(key: string): string | null {
      return storage.has(key) ? storage.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      storage.set(key, value);
    },
    removeItem(key: string): void {
      storage.delete(key);
    },
    clear(): void {
      storage.clear();
    }
  };

  Object.assign(globalThis, {
    localStorage,
    window: {
      localStorage,
      setTimeout,
      clearTimeout,
      tuanzi: {
        sendMessage: async () => sendMessageResult
      }
    }
  });
}

function createFakeSurface() {
  const textContainer = { innerHTML: "" };
  const contentEl = {
    appendChild() {
      return;
    },
    querySelectorAll(selector: string) {
      if (selector === ".markdown-text") {
        return [textContainer];
      }
      return [];
    }
  };

  return {
    contentEl,
    blocksContainer: {
      appendChild() {
        return;
      }
    },
    textContainer
  };
}

test("sendMessage stores completed tool calls into the synced turn", async () => {
  installBrowserStubs();

  const activeSession: ChatSession = {
    id: "session-1",
    title: "New Chat",
    workspace: "E:/project",
    history: [],
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-20T00:00:00.000Z"
  };

  let syncedTurn: Record<string, unknown> | null = null;

  await sendMessage({
    state: {
      pendingImage: null,
      isThinking: false,
      planModeEnabled: false,
      isSending: false,
      isStopping: false,
      currentTaskId: "",
      currentRenderedToolCalls: 0,
      currentStreamText: ""
    },
    inputTextarea: { value: "hello" } as HTMLTextAreaElement,
    beginStreamingUi: () => {
      return;
    },
    endStreamingUi: () => {
      return;
    },
    autoResizeTextarea: () => {
      return;
    },
    clearPendingImage: () => {
      return;
    },
    closeSlashCommandMenu: () => {
      return;
    },
    executeSlashCommand: async () => false,
    showError: () => {
      return;
    },
    addUserMessage: () => {
      return;
    },
    createAssistantSurface: () => createFakeSurface() as any,
    scrollToBottom: () => {
      return;
    },
    buildStreamingListeners: ({ textContainer }) =>
      ({
        dispose: () => {
          return;
        },
        getCurrentThinkingText: () => "",
        getThinkingBlock: () => null,
        getActiveTextContainer: () => textContainer
      }) as any,
    finalizeThinkingBlock: () => {
      return;
    },
    finalizeAllThinkingBlocks: () => {
      return;
    },
    getActiveAgent: () => null,
    ensureActiveSession: () => activeSession,
    renderToolCalls: () => {
      return;
    },
    renderMarkdownHtml: (text) => text,
    syncInterruptedTurn: (_session, input) => {
      syncedTurn = input as Record<string, unknown>;
    },
    resetSessionWorkbench: () => {
      return;
    },
    truncateTitleFromInput: (value) => value,
    touchActiveSession: () => {
      return;
    },
    persistSessions: () => {
      return;
    },
    renderSessionList: () => {
      return;
    },
    defaultSessionTitle: "New Chat",
    escapeHtml: (text) => text
  });

  assert.ok(syncedTurn, "expected sendMessage to sync the completed turn");
  const persistedTurn = syncedTurn as { toolCalls?: Array<{ toolName: string }>; checkpointId?: string };
  assert.equal(Array.isArray(persistedTurn.toolCalls), true);
  assert.equal(persistedTurn.toolCalls?.[0]?.toolName, "read_file");
  assert.equal(persistedTurn.checkpointId, "checkpoint-1");
});

test("session-store keeps tool calls when reloading sessions from storage", () => {
  installBrowserStubs();

  localStorage.setItem(
    "session-test",
    JSON.stringify({
      version: 1,
      activeSessionId: "session-1",
      sessions: [
        {
          id: "session-1",
          title: "Saved Chat",
          workspace: "E:/project",
          createdAt: "2026-03-20T00:00:00.000Z",
          updatedAt: "2026-03-20T00:00:00.000Z",
          history: [
            {
              user: "hello",
              assistant: "world",
              interrupted: false,
              toolCalls: [
                {
                  toolName: "read_file",
                  args: { path: "README.md" },
                  result: { ok: true, data: "hello" },
                  timestamp: "2026-03-20T00:00:00.000Z"
                }
              ]
            }
          ]
        }
      ]
    })
  );

  const state = {
    sessions: [] as ChatSession[],
    activeSessionId: ""
  };

  createSessionStore({
    state,
    defaultSessionTitle: "New Chat",
    maxSessionHistory: 20,
    titleMaxChars: 20,
    sessionStorageKey: "session-test",
    sessionPersistDebounceMs: 0,
    sessionPersistPerfLog: () => {
      return;
    }
  }).loadSessionsFromStorage();

  assert.equal(state.sessions.length, 1);
  assert.equal(Array.isArray((state.sessions[0].history[0] as any).toolCalls), true);
  assert.equal(state.sessions[0].history[0].toolCalls?.[0]?.toolName, "read_file");
});

test("session-store keeps checkpointId when reloading sessions from storage", () => {
  installBrowserStubs();

  localStorage.setItem(
    "session-test",
    JSON.stringify({
      version: 1,
      activeSessionId: "session-1",
      sessions: [
        {
          id: "session-1",
          title: "Saved Chat",
          workspace: "E:/project",
          createdAt: "2026-03-20T00:00:00.000Z",
          updatedAt: "2026-03-20T00:00:00.000Z",
          history: [
            {
              user: "hello",
              assistant: "world",
              interrupted: false,
              checkpointId: "checkpoint-1"
            }
          ]
        }
      ]
    })
  );

  const state = {
    sessions: [] as ChatSession[],
    activeSessionId: ""
  };

  createSessionStore({
    state,
    defaultSessionTitle: "New Chat",
    maxSessionHistory: 20,
    titleMaxChars: 20,
    sessionStorageKey: "session-test",
    sessionPersistDebounceMs: 0,
    sessionPersistPerfLog: () => {
      return;
    }
  }).loadSessionsFromStorage();

  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].history[0].checkpointId, "checkpoint-1");
});

test("sendMessage keeps checkpointId for interrupted turns", async () => {
  installBrowserStubs({
    ok: false,
    taskId: "task-1",
    interrupted: true,
    checkpointId: "checkpoint-2",
    resumeSnapshot: {
      version: 1,
      taskId: "task-1",
      sessionId: "session-1",
      workspace: "E:/project",
      message: "hello",
      history: [],
      agentId: null,
      thinkingEnabled: false,
      streamedText: "partial",
      streamedThinking: "thinking",
      toolCalls: [
        {
          id: "tool-1",
          name: "read_file",
          args: { path: "README.md" },
          result: { ok: true, data: "hello" }
        }
      ],
      updatedAt: "2026-03-20T00:00:00.000Z"
    }
  });

  const activeSession: ChatSession = {
    id: "session-1",
    title: "New Chat",
    workspace: "E:/project",
    history: [],
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-20T00:00:00.000Z"
  };

  let syncedTurn: Record<string, unknown> | null = null;

  await sendMessage({
    state: {
      pendingImage: null,
      isThinking: false,
      planModeEnabled: false,
      isSending: false,
      isStopping: false,
      currentTaskId: "",
      currentRenderedToolCalls: 0,
      currentStreamText: ""
    },
    inputTextarea: { value: "hello" } as HTMLTextAreaElement,
    beginStreamingUi: () => {
      return;
    },
    endStreamingUi: () => {
      return;
    },
    autoResizeTextarea: () => {
      return;
    },
    clearPendingImage: () => {
      return;
    },
    closeSlashCommandMenu: () => {
      return;
    },
    executeSlashCommand: async () => false,
    showError: () => {
      return;
    },
    addUserMessage: () => {
      return;
    },
    createAssistantSurface: () => createFakeSurface() as any,
    scrollToBottom: () => {
      return;
    },
    buildStreamingListeners: ({ textContainer }) =>
      ({
        dispose: () => {
          return;
        },
        getCurrentThinkingText: () => "",
        getThinkingBlock: () => null,
        getActiveTextContainer: () => textContainer
      }) as any,
    finalizeThinkingBlock: () => {
      return;
    },
    finalizeAllThinkingBlocks: () => {
      return;
    },
    getActiveAgent: () => null,
    ensureActiveSession: () => activeSession,
    renderToolCalls: () => {
      return;
    },
    renderMarkdownHtml: (text) => text,
    syncInterruptedTurn: (_session, input) => {
      syncedTurn = input as Record<string, unknown>;
    },
    resetSessionWorkbench: () => {
      return;
    },
    truncateTitleFromInput: (value) => value,
    touchActiveSession: () => {
      return;
    },
    persistSessions: () => {
      return;
    },
    renderSessionList: () => {
      return;
    },
    defaultSessionTitle: "New Chat",
    escapeHtml: (text) => text
  });

  assert.ok(syncedTurn, "expected sendMessage to sync the interrupted turn");
  assert.equal((syncedTurn as { checkpointId?: string }).checkpointId, "checkpoint-2");
});

test("refreshResumeSnapshot keeps checkpointId for interrupted turns", async () => {
  installBrowserStubs();

  const activeSession: ChatSession = {
    id: "session-1",
    title: "New Chat",
    workspace: "E:/project",
    history: [],
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-20T00:00:00.000Z"
  };

  let syncedTurn: Record<string, unknown> | null = null;

  (window.tuanzi as unknown as { getResumeState?: (payload?: unknown) => Promise<unknown> }).getResumeState = async () => ({
    ok: true,
    resumeSnapshot: {
      version: 1,
      taskId: "task-1",
      sessionId: "session-1",
      workspace: "E:/project",
      message: "hello",
      history: [],
      agentId: null,
      thinkingEnabled: false,
      streamedText: "partial",
      streamedThinking: "thinking",
      toolCalls: [],
      checkpointId: "checkpoint-3",
      updatedAt: "2026-03-20T00:00:00.000Z"
    }
  });

  await refreshResumeSnapshot({
    getActiveSession: () => activeSession,
    showError: () => {
      return;
    },
    syncInterruptedTurn: (_session, input) => {
      syncedTurn = input as Record<string, unknown>;
    },
    touchActiveSession: () => {
      return;
    },
    persistSessions: () => {
      return;
    },
    renderSessionList: () => {
      return;
    }
  });

  assert.ok(syncedTurn, "expected refreshResumeSnapshot to sync the interrupted turn");
  assert.equal((syncedTurn as { checkpointId?: string }).checkpointId, "checkpoint-3");
});

test("renderActiveConversation replays stored tool calls for assistant messages", () => {
  const session: ChatSession = {
    id: "session-1",
    title: "Saved Chat",
    workspace: "E:/project",
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-20T00:00:00.000Z",
    history: [
      {
        user: "hello",
        assistant: "world",
        toolCalls: [
          {
            toolName: "read_file",
            args: { path: "README.md" },
            result: { ok: true, data: "hello" },
            timestamp: "2026-03-20T00:00:00.000Z"
          }
        ]
      }
    ]
  };

  const assistantCalls: Array<unknown[]> = [];
  const chatArea = {
    innerHTML: "",
    appendChild() {
      return;
    }
  } as unknown as HTMLDivElement;
  const welcomeState = {
    style: { display: "" }
  } as unknown as HTMLDivElement;

  const actions = createSessionActions({
    state: {
      sessions: [session],
      activeSessionId: session.id
    },
    chatArea,
    welcomeState,
    workspaceLabel: {} as HTMLSpanElement,
    emptyWorkspaceLabel: "",
    emptyWorkspaceTitle: "",
    getActiveSession: () => session,
    addUserMessage: () => {
      return;
    },
    addAssistantMessage: (...args: unknown[]) => {
      assistantCalls.push(args);
    },
    scrollToBottom: () => {
      return;
    },
    clearPendingImage: () => {
      return;
    },
    renderSessionList: () => {
      return;
    },
    persistSessions: () => {
      return;
    },
    refreshResumeSnapshot: async () => {
      return;
    }
  });

  actions.renderActiveConversation();

  assert.equal(assistantCalls.length, 1);
  assert.equal(Array.isArray(assistantCalls[0][2]), true);
  assert.equal(((assistantCalls[0][2] as Array<{ toolName: string }>)[0] ?? {}).toolName, "read_file");
});
