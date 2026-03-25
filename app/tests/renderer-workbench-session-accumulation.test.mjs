import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "../node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url);
const { createWorkbenchFeature } = await jiti.import("../src/renderer/src/features/workbench/workbench-feature.ts");
const { sendMessage } = await jiti.import("../src/renderer/src/features/chat/send-message.ts");

const WORKBENCH_STORAGE_KEY = "tuanzi.desktop.workbench.v1";

class FakeClassList {
  #tokens = new Set();

  add(...tokens) {
    for (const token of tokens) {
      this.#tokens.add(token);
    }
  }

  remove(...tokens) {
    for (const token of tokens) {
      this.#tokens.delete(token);
    }
  }

  toggle(token, force) {
    if (force === undefined) {
      if (this.#tokens.has(token)) {
        this.#tokens.delete(token);
        return false;
      }
      this.#tokens.add(token);
      return true;
    }
    if (force) {
      this.#tokens.add(token);
      return true;
    }
    this.#tokens.delete(token);
    return false;
  }

  contains(token) {
    return this.#tokens.has(token);
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.className = "";
    this.textContent = "";
    this.innerHTML = "";
    this.children = [];
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.listeners = new Map();
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  appendChild(node) {
    this.children.push(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.children = [...nodes];
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  addEventListener(name, callback) {
    const existing = this.listeners.get(name) ?? [];
    existing.push(callback);
    this.listeners.set(name, existing);
  }

  contains(target) {
    if (target === this) {
      return true;
    }
    return this.children.some((child) => typeof child?.contains === "function" && child.contains(target));
  }
}

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    }
  };
}

function installWorkbenchGlobals(storage = createStorage()) {
  const document = {
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    addEventListener() {
      return;
    }
  };

  const windowObject = {
    localStorage: storage,
    setTimeout,
    clearTimeout,
    addEventListener() {
      return;
    }
  };

  Object.assign(globalThis, {
    localStorage: storage,
    document,
    window: windowObject
  });

  return { storage };
}

function createWorkbenchApi() {
  const taskListeners = [];
  const modifiedFileListeners = [];
  return {
    onTasks(callback) {
      taskListeners.push(callback);
      return () => {
        return;
      };
    },
    onModifiedFiles(callback) {
      modifiedFileListeners.push(callback);
      return () => {
        return;
      };
    },
    emitTasks(payload) {
      for (const listener of taskListeners) {
        listener(payload);
      }
    },
    emitModifiedFiles(payload) {
      for (const listener of modifiedFileListeners) {
        listener(payload);
      }
    }
  };
}

function createWorkbenchDeps(state, api) {
  return {
    state,
    tasksPanel: new FakeElement("div"),
    filesPanel: new FakeElement("div"),
    tasksToggle: new FakeElement("button"),
    filesToggle: new FakeElement("button"),
    tasksBody: new FakeElement("div"),
    filesBody: new FakeElement("div"),
    tasksCount: new FakeElement("span"),
    filesCount: new FakeElement("span"),
    api
  };
}

function waitForPersist() {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

function createFakeSurface() {
  const textContainer = { innerHTML: "" };
  const contentEl = {
    querySelectorAll(selector) {
      if (selector === ".markdown-text") {
        return [textContainer];
      }
      return [];
    }
  };
  return {
    contentEl,
    blocksContainer: new FakeElement("div"),
    textContainer
  };
}

test("workbench accumulates task groups by task id and deduplicates files across a session", async () => {
  const { storage } = installWorkbenchGlobals();
  const api = createWorkbenchApi();
  const state = {
    activeSessionId: "session-1",
    sessions: [
      { id: "session-1", workspace: "E:/project" },
      { id: "session-2", workspace: "E:/other" }
    ],
    tasksExpanded: false,
    filesExpanded: false,
    sessionWorkbench: {}
  };

  createWorkbenchFeature(createWorkbenchDeps(state, api)).bind();

  api.emitTasks({
    taskId: "task-1",
    sessionId: "session-1",
    tasks: [
      { id: "plan-1", title: "Task one", kind: "plan", status: "running" },
      { id: "child-1", title: "Search files", kind: "search", status: "done", parentGroupId: "plan-1" }
    ]
  });
  api.emitTasks({
    taskId: "task-empty",
    sessionId: "session-1",
    tasks: []
  });
  api.emitTasks({
    taskId: "task-2",
    sessionId: "session-1",
    tasks: [{ id: "exec-1", title: "Implement fix", kind: "execution", status: "done" }]
  });
  api.emitTasks({
    taskId: "task-1",
    sessionId: "session-1",
    tasks: [
      { id: "plan-1", title: "Task one", kind: "plan", status: "done" },
      { id: "child-1", title: "Search files", kind: "search", status: "done", parentGroupId: "plan-1" }
    ]
  });

  api.emitModifiedFiles({
    taskId: "task-1",
    sessionId: "session-1",
    files: [{ path: "src/a.ts", added: 1, removed: 0 }]
  });
  api.emitModifiedFiles({
    taskId: "task-2",
    sessionId: "session-1",
    files: [
      { path: "src/b.ts", added: 2, removed: 1 },
      { path: "src/a.ts", added: 5, removed: 3 }
    ]
  });

  await waitForPersist();

  const sessionState = state.sessionWorkbench["session-1"];
  assert.equal(sessionState.taskGroups.length, 2);
  assert.equal(sessionState.taskGroups.some((group) => group.taskId === "task-empty"), false);

  const firstGroup = sessionState.taskGroups.find((group) => group.taskId === "task-1");
  const secondGroup = sessionState.taskGroups.find((group) => group.taskId === "task-2");

  assert.equal(firstGroup?.tasks[0]?.status, "done");
  assert.equal(secondGroup?.tasks[0]?.title, "Implement fix");
  assert.deepEqual(sessionState.modifiedFiles, [
    { path: "src/a.ts", added: 5, removed: 3 },
    { path: "src/b.ts", added: 2, removed: 1 }
  ]);

  const persisted = JSON.parse(storage.getItem(WORKBENCH_STORAGE_KEY));
  assert.equal(persisted.version, 2);
  assert.equal(persisted.sessions["session-1"].taskGroups.length, 2);
  assert.deepEqual(persisted.sessions["session-1"].modifiedFiles, [
    { path: "src/a.ts", added: 5, removed: 3 },
    { path: "src/b.ts", added: 2, removed: 1 }
  ]);
});

test("workbench migrates v1 persistence and keeps per-session state isolated", async () => {
  const storage = createStorage();
  storage.setItem(
    WORKBENCH_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      sessions: {
        "session-1": {
          tasks: [{ id: "plan-legacy", title: "Legacy task", kind: "plan", status: "done" }],
          modifiedFiles: [{ path: "src/legacy.ts", added: 4, removed: 0 }]
        }
      }
    })
  );

  installWorkbenchGlobals(storage);
  const api = createWorkbenchApi();
  const state = {
    activeSessionId: "session-1",
    sessions: [
      { id: "session-1", workspace: "E:/project" },
      { id: "session-2", workspace: "E:/other" }
    ],
    tasksExpanded: false,
    filesExpanded: false,
    sessionWorkbench: {}
  };

  createWorkbenchFeature(createWorkbenchDeps(state, api)).bind();

  assert.equal(state.sessionWorkbench["session-1"].taskGroups.length, 1);
  assert.deepEqual(state.sessionWorkbench["session-1"].modifiedFiles, [
    { path: "src/legacy.ts", added: 4, removed: 0 }
  ]);

  api.emitTasks({
    taskId: "task-2",
    sessionId: "session-2",
    tasks: [{ id: "exec-2", title: "Other session task", kind: "execution", status: "running" }]
  });
  api.emitModifiedFiles({
    taskId: "task-2",
    sessionId: "session-2",
    files: [{ path: "src/other.ts", added: 7, removed: 1 }]
  });

  await waitForPersist();

  assert.equal(state.sessionWorkbench["session-1"].taskGroups.length, 1);
  assert.equal(state.sessionWorkbench["session-2"].taskGroups.length, 1);
  assert.deepEqual(state.sessionWorkbench["session-2"].modifiedFiles, [
    { path: "src/other.ts", added: 7, removed: 1 }
  ]);

  const persisted = JSON.parse(storage.getItem(WORKBENCH_STORAGE_KEY));
  assert.equal(persisted.version, 2);
  assert.equal(persisted.sessions["session-1"].taskGroups.length, 1);
  assert.equal(persisted.sessions["session-2"].taskGroups.length, 1);
});

test("sendMessage does not reset session workbench before starting a new request", async () => {
  const storage = createStorage();
  Object.assign(globalThis, {
    localStorage: storage,
    window: {
      localStorage: storage,
      setTimeout,
      clearTimeout,
      tuanzi: {
        sendMessage: async () => ({
          ok: true,
          taskId: "task-1",
          summary: "done",
          checkpointId: "checkpoint-1",
          toolCalls: []
        })
      }
    }
  });

  const activeSession = {
    id: "session-1",
    title: "New Chat",
    workspace: "E:/project",
    history: [],
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-20T00:00:00.000Z"
  };

  let resetCalls = 0;
  let syncedTurn = null;

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
    inputTextarea: { value: "hello" },
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
    createAssistantSurface: () => createFakeSurface(),
    scrollToBottom: () => {
      return;
    },
    buildStreamingListeners: ({ textContainer }) => ({
      dispose: () => {
        return;
      },
      getCurrentThinkingText: () => "",
      getThinkingBlock: () => null,
      getAllThinkingBlocks: () => [],
      getActiveTextContainer: () => textContainer
    }),
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
      syncedTurn = input;
    },
    resetSessionWorkbench: () => {
      resetCalls += 1;
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

  assert.equal(resetCalls, 0);
  assert.equal(syncedTurn.user, "hello");
});
