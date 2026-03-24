import type {
  ModifiedFileEntry,
  TuanziAPI,
  WorkbenchTaskItem
} from "../../../../shared/ipc-contracts";
import type { SessionWorkbenchState } from "../../app/state";

interface WorkbenchState {
  activeSessionId: string;
  sessions: Array<{ id: string; workspace: string }>;
  workbenchOpen: boolean;
  sessionWorkbench: Record<string, SessionWorkbenchState>;
}

interface WorkbenchFeatureDeps {
  state: WorkbenchState;
  drawer: HTMLElement;
  tasksContainer: HTMLDivElement;
  tasksCount: HTMLSpanElement;
  filesCount: HTMLSpanElement;
  filesContainer: HTMLDivElement;
  pageButtons: HTMLButtonElement[];
  toggleButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
  api: Pick<TuanziAPI, "onTasks" | "onModifiedFiles">;
}

export interface WorkbenchFeature {
  bind: () => void;
  renderCurrentSessionWorkbench: () => void;
  resetSessionWorkbench: (sessionId: string) => void;
}

type WorkbenchPage = "tasks" | "files";
const WORKBENCH_STORAGE_KEY = "tuanzi.desktop.workbench.v1";
const WORKBENCH_PERSIST_DEBOUNCE_MS = 180;

interface PersistedWorkbenchSessionState {
  tasks: WorkbenchTaskItem[];
  modifiedFiles: ModifiedFileEntry[];
}

interface PersistedWorkbenchPayload {
  version: 1;
  sessions: Record<string, PersistedWorkbenchSessionState>;
}

export function createWorkbenchFeature(input: WorkbenchFeatureDeps): WorkbenchFeature {
  let persistTimer: number | null = null;
  let activePage: WorkbenchPage = "tasks";

  function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function toPersistedSessionState(state: SessionWorkbenchState): PersistedWorkbenchSessionState {
    return {
      tasks: state.tasks,
      modifiedFiles: state.modifiedFiles
    };
  }

  function normalizeTask(value: unknown): WorkbenchTaskItem | null {
    if (!isRecord(value)) {
      return null;
    }
    if (typeof value.id !== "string" || typeof value.title !== "string") {
      return null;
    }
    if (
      value.kind !== "plan" &&
      value.kind !== "execution" &&
      value.kind !== "search" &&
      value.kind !== "coding" &&
      value.kind !== "subagent"
    ) {
      return null;
    }
    if (
      value.status !== "pending" &&
      value.status !== "running" &&
      value.status !== "done" &&
      value.status !== "failed"
    ) {
      return null;
    }
    return {
      id: value.id,
      title: value.title,
      kind: value.kind,
      status: value.status,
      ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
      ...(typeof value.parentGroupId === "string" ? { parentGroupId: value.parentGroupId } : {})
    };
  }

  function normalizeModifiedFile(value: unknown): ModifiedFileEntry | null {
    if (!isRecord(value) || typeof value.path !== "string") {
      return null;
    }
    const added = typeof value.added === "number" && Number.isFinite(value.added) ? Math.max(0, Math.floor(value.added)) : 0;
    const removed = typeof value.removed === "number" && Number.isFinite(value.removed) ? Math.max(0, Math.floor(value.removed)) : 0;
    return {
      path: value.path,
      added,
      removed
    };
  }

  function normalizePersistedSessionState(value: unknown): SessionWorkbenchState | null {
    if (!isRecord(value)) {
      return null;
    }
    const tasks = Array.isArray(value.tasks)
      ? value.tasks.map(normalizeTask).filter((item): item is WorkbenchTaskItem => item !== null)
      : [];
    const modifiedFiles = Array.isArray(value.modifiedFiles)
      ? value.modifiedFiles.map(normalizeModifiedFile).filter((item): item is ModifiedFileEntry => item !== null)
      : [];
    return {
      tasks,
      modifiedFiles
    };
  }

  function flushPersistSessionWorkbench(): void {
    const payload: PersistedWorkbenchPayload = {
      version: 1,
      sessions: {}
    };
    const validSessionIds = new Set(input.state.sessions.map((session) => session.id));
    for (const [sessionId, state] of Object.entries(input.state.sessionWorkbench)) {
      if (!validSessionIds.has(sessionId)) {
        continue;
      }
      payload.sessions[sessionId] = toPersistedSessionState(state);
    }
    try {
      localStorage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      return;
    }
  }

  function schedulePersistSessionWorkbench(): void {
    if (persistTimer !== null) {
      window.clearTimeout(persistTimer);
    }
    persistTimer = window.setTimeout(() => {
      persistTimer = null;
      flushPersistSessionWorkbench();
    }, WORKBENCH_PERSIST_DEBOUNCE_MS);
  }

  function hydrateSessionWorkbenchFromStorage(): void {
    let parsed: unknown = null;
    try {
      const raw = localStorage.getItem(WORKBENCH_STORAGE_KEY);
      if (!raw) {
        return;
      }
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.sessions)) {
      return;
    }

    const validSessionIds = new Set(input.state.sessions.map((session) => session.id));
    for (const [sessionId, persistedState] of Object.entries(parsed.sessions)) {
      if (!validSessionIds.has(sessionId)) {
        continue;
      }
      const normalized = normalizePersistedSessionState(persistedState);
      if (!normalized) {
        continue;
      }
      input.state.sessionWorkbench[sessionId] = normalized;
    }
  }

  function ensureSessionState(sessionId: string): SessionWorkbenchState {
    const existing = input.state.sessionWorkbench[sessionId];
    if (existing) {
      return existing;
    }
    const created: SessionWorkbenchState = {
      tasks: [],
      modifiedFiles: []
    };
    input.state.sessionWorkbench[sessionId] = created;
    return created;
  }

  function getCurrentSessionState(): SessionWorkbenchState {
    return ensureSessionState(input.state.activeSessionId);
  }

  function renderDrawerState(): void {
    const isOpen = input.state.workbenchOpen;
    input.drawer.classList.toggle("open", isOpen);
    input.drawer.setAttribute("aria-hidden", isOpen ? "false" : "true");
    input.drawer.setAttribute("data-workbench-page", activePage);
    input.pageButtons.forEach((button) => {
      const page = (button.dataset.workbenchPage as WorkbenchPage | undefined) ?? "tasks";
      const isActive = page === activePage;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    input.toggleButton.classList.toggle("active", isOpen);
    input.toggleButton.setAttribute("aria-expanded", isOpen ? "true" : "false");
    input.toggleButton.title = isOpen ? "Collapse Workbench" : "Expand Workbench";
  }

  const collapsedGroups = new Set<string>();

  function renderTaskItem(task: WorkbenchTaskItem): HTMLDivElement {
    const item = document.createElement("div");
    item.className = "workbench-task-item";

    const status = document.createElement("div");
    status.className = `workbench-task-status ${task.status}`;
    status.textContent = task.status === "done" ? "ok" : task.status === "failed" ? "!" : task.status === "running" ? "..." : "";

    const body = document.createElement("div");
    const title = document.createElement("div");
    title.className = "workbench-task-title";
    title.textContent = task.title;
    body.appendChild(title);
    if (task.detail) {
      const detail = document.createElement("div");
      detail.className = "workbench-task-detail";
      detail.textContent = task.detail;
      body.appendChild(detail);
    }

    item.append(status, body);
    return item;
  }

  function renderTasks(tasks: WorkbenchTaskItem[]): void {
    const groupHeaders = tasks.filter((task) => !task.parentGroupId && task.kind === "plan");
    const groupChildren = new Map<string, WorkbenchTaskItem[]>();
    const standaloneItems: WorkbenchTaskItem[] = [];

    for (const task of tasks) {
      if (task.parentGroupId) {
        const list = groupChildren.get(task.parentGroupId);
        if (list) {
          list.push(task);
        } else {
          groupChildren.set(task.parentGroupId, [task]);
        }
      } else if (task.kind !== "plan") {
        standaloneItems.push(task);
      }
    }

    const totalCount = groupHeaders.length + standaloneItems.length;
    input.tasksCount.textContent = String(totalCount || tasks.length);
    if (tasks.length === 0) {
      input.tasksContainer.innerHTML = '<div class="workbench-empty">当前会话还没有任务记录</div>';
      return;
    }

    const container = document.createElement("div");
    container.className = "workbench-task-list";

    for (const header of groupHeaders) {
      const isCollapsed = collapsedGroups.has(header.id);
      const children = groupChildren.get(header.id) ?? [];

      const group = document.createElement("div");
      group.className = `workbench-task-group${isCollapsed ? " collapsed" : ""}`;

      const groupHeader = document.createElement("div");
      groupHeader.className = "workbench-task-group-header";
      groupHeader.addEventListener("click", () => {
        if (collapsedGroups.has(header.id)) {
          collapsedGroups.delete(header.id);
        } else {
          collapsedGroups.add(header.id);
        }
        renderTasks(tasks);
      });

      const arrow = document.createElement("span");
      arrow.className = "workbench-task-group-arrow";
      arrow.textContent = isCollapsed ? "+" : "-";

      const headerStatus = document.createElement("div");
      headerStatus.className = `workbench-task-status ${header.status}`;
      headerStatus.textContent = header.status === "done" ? "ok" : header.status === "failed" ? "!" : header.status === "running" ? "..." : "";

      const headerTitle = document.createElement("div");
      headerTitle.className = "workbench-task-group-title";
      headerTitle.textContent = header.title;

      const headerMeta = document.createElement("span");
      headerMeta.className = "workbench-task-group-meta";
      const doneCount = children.filter((child) => child.status === "done").length;
      headerMeta.textContent = `${doneCount}/${children.length}`;

      groupHeader.append(arrow, headerStatus, headerTitle, headerMeta);
      group.appendChild(groupHeader);

      if (!isCollapsed && children.length > 0) {
        const groupBody = document.createElement("div");
        groupBody.className = "workbench-task-group-body";
        for (const child of children) {
          groupBody.appendChild(renderTaskItem(child));
        }
        group.appendChild(groupBody);
      }

      container.appendChild(group);
    }

    for (const task of standaloneItems) {
      container.appendChild(renderTaskItem(task));
    }

    input.tasksContainer.replaceChildren(container);
  }

  function renderFiles(files: ModifiedFileEntry[]): void {
    input.filesCount.textContent = String(files.length);
    if (files.length === 0) {
      input.filesContainer.innerHTML = '<div class="workbench-empty">当前会话还没有文件改动</div>';
      return;
    }

    const list = document.createElement("div");
    list.className = "workbench-file-list";
    for (const file of files) {
      const item = document.createElement("div");
      item.className = "workbench-file-item";
      item.innerHTML = `
        <div class="workbench-file-row">
          <span class="workbench-file-path">${escapeHtml(file.path)}</span>
          <span class="workbench-file-diff"><span class="added">+${file.added}</span> <span class="removed">-${file.removed}</span></span>
        </div>
      `;
      list.appendChild(item);
    }
    input.filesContainer.replaceChildren(list);
  }

  function renderCurrentSessionWorkbench(): void {
    renderDrawerState();
    const current = getCurrentSessionState();
    renderTasks(current.tasks);
    renderFiles(current.modifiedFiles);
  }

  function bind(): void {
    hydrateSessionWorkbenchFromStorage();

    input.pageButtons.forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const page = button.dataset.workbenchPage as WorkbenchPage | undefined;
        if (!page || page === activePage) {
          return;
        }
        activePage = page;
        renderCurrentSessionWorkbench();
      });
    });

    input.toggleButton.addEventListener("click", () => {
      input.state.workbenchOpen = !input.state.workbenchOpen;
      renderCurrentSessionWorkbench();
    });

    input.closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      input.state.workbenchOpen = false;
      renderCurrentSessionWorkbench();
    });

    window.addEventListener("beforeunload", () => {
      flushPersistSessionWorkbench();
    });

    input.api.onTasks((data) => {
      ensureSessionState(data.sessionId).tasks = data.tasks;
      schedulePersistSessionWorkbench();
      renderCurrentSessionWorkbench();
    });

    input.api.onModifiedFiles((data) => {
      ensureSessionState(data.sessionId).modifiedFiles = data.files;
      schedulePersistSessionWorkbench();
      renderCurrentSessionWorkbench();
    });

    renderCurrentSessionWorkbench();
  }

  function resetSessionWorkbench(sessionId: string): void {
    input.state.sessionWorkbench[sessionId] = {
      tasks: [],
      modifiedFiles: []
    };
    schedulePersistSessionWorkbench();
    renderCurrentSessionWorkbench();
  }

  return {
    bind,
    renderCurrentSessionWorkbench,
    resetSessionWorkbench
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
