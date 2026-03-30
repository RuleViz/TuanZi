import type {
  ModifiedFileEntry,
  TuanziAPI,
  WorkbenchTaskItem
} from "../../../../shared/ipc-contracts";
import type { SessionWorkbenchState, SessionWorkbenchTaskGroup } from "../../app/state";

interface WorkbenchState {
  activeSessionId: string;
  sessions: Array<{ id: string; workspace: string }>;
  tasksExpanded: boolean;
  filesExpanded: boolean;
  sessionWorkbench: Record<string, SessionWorkbenchState>;
}

interface WorkbenchFeatureDeps {
  state: WorkbenchState;
  tasksPanel: HTMLDivElement;
  filesPanel: HTMLDivElement;
  tasksToggle: HTMLButtonElement;
  filesToggle: HTMLButtonElement;
  tasksBody: HTMLDivElement;
  filesBody: HTMLDivElement;
  tasksCount: HTMLSpanElement;
  filesCount: HTMLSpanElement;
  api: Pick<TuanziAPI, "onTasks" | "onModifiedFiles">;
}

export interface WorkbenchFeature {
  bind: () => void;
  renderCurrentSessionWorkbench: () => void;
  resetSessionWorkbench: (sessionId: string) => void;
  removeTaskGroupsByOrigin: (sessionId: string, checkpointId: string) => void;
}

const WORKBENCH_STORAGE_KEY = "tuanzi.desktop.workbench.v1";
const WORKBENCH_PERSIST_DEBOUNCE_MS = 180;
const LEGACY_TASK_GROUP_TIMESTAMP = "1970-01-01T00:00:00.000Z";

interface PersistedWorkbenchTaskGroup {
  taskId: string;
  title: string;
  tasks: WorkbenchTaskItem[];
  updatedAt: string;
}

interface PersistedWorkbenchSessionStateV2 {
  taskGroups: PersistedWorkbenchTaskGroup[];
  modifiedFiles: ModifiedFileEntry[];
}

interface PersistedWorkbenchPayloadV2 {
  version: 2;
  sessions: Record<string, PersistedWorkbenchSessionStateV2>;
}

export function createWorkbenchFeature(input: WorkbenchFeatureDeps): WorkbenchFeature {
  let persistTimer: number | null = null;
  const collapsedPlanGroups = new Set<string>();
  const collapsedTaskGroups = new Set<string>();

  function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function createEmptySessionState(): SessionWorkbenchState {
    return {
      taskGroups: [],
      modifiedFiles: []
    };
  }

  function toPersistedTaskGroup(group: SessionWorkbenchTaskGroup): PersistedWorkbenchTaskGroup {
    return {
      taskId: group.taskId,
      title: group.title,
      tasks: group.tasks,
      updatedAt: group.updatedAt
    };
  }

  function toPersistedSessionState(state: SessionWorkbenchState): PersistedWorkbenchSessionStateV2 {
    return {
      taskGroups: state.taskGroups.map((group) => toPersistedTaskGroup(group)),
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
      ...(typeof value.parentGroupId === "string" ? { parentGroupId: value.parentGroupId } : {}),
      ...(typeof value.originCheckpointId === "string" ? { originCheckpointId: value.originCheckpointId } : {})
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

  function normalizePersistedTaskGroup(value: unknown): SessionWorkbenchTaskGroup | null {
    if (!isRecord(value) || typeof value.taskId !== "string" || typeof value.title !== "string") {
      return null;
    }
    if (!Array.isArray(value.tasks) || typeof value.updatedAt !== "string") {
      return null;
    }
    const tasks = value.tasks.map(normalizeTask).filter((item): item is WorkbenchTaskItem => item !== null);
    return {
      taskId: value.taskId,
      title: value.title,
      tasks,
      updatedAt: value.updatedAt
    };
  }

  function deriveTaskGroupTitle(tasks: WorkbenchTaskItem[], fallbackIndex: number): string {
    const primaryTask =
      tasks.find((task) => !task.parentGroupId && task.kind === "plan") ??
      tasks.find((task) => !task.parentGroupId) ??
      tasks[0];
    const title = primaryTask?.title.trim();
    return title || `Task ${fallbackIndex}`;
  }

  function normalizePersistedSessionState(value: unknown, sessionId: string): SessionWorkbenchState | null {
    if (!isRecord(value)) {
      return null;
    }
    const taskGroups = Array.isArray(value.taskGroups)
      ? value.taskGroups.map(normalizePersistedTaskGroup).filter((item): item is SessionWorkbenchTaskGroup => item !== null)
      : [];
    const modifiedFiles = Array.isArray(value.modifiedFiles)
      ? value.modifiedFiles.map(normalizeModifiedFile).filter((item): item is ModifiedFileEntry => item !== null)
      : [];
    if (taskGroups.length > 0) {
      return {
        taskGroups,
        modifiedFiles: sortModifiedFiles(modifiedFiles)
      };
    }
    const legacyTasks = Array.isArray(value.tasks)
      ? value.tasks.map(normalizeTask).filter((item): item is WorkbenchTaskItem => item !== null)
      : [];
    return {
      taskGroups:
        legacyTasks.length > 0
          ? [
              {
                taskId: `legacy-${sessionId}`,
                title: deriveTaskGroupTitle(legacyTasks, 1),
                tasks: legacyTasks,
                updatedAt: LEGACY_TASK_GROUP_TIMESTAMP
              }
            ]
          : [],
      modifiedFiles: sortModifiedFiles(modifiedFiles)
    };
  }

  function flushPersistSessionWorkbench(): void {
    const payload: PersistedWorkbenchPayloadV2 = {
      version: 2,
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

    if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== 2) || !isRecord(parsed.sessions)) {
      return;
    }

    const validSessionIds = new Set(input.state.sessions.map((session) => session.id));
    for (const [sessionId, persistedState] of Object.entries(parsed.sessions)) {
      if (!validSessionIds.has(sessionId)) {
        continue;
      }
      const normalized = normalizePersistedSessionState(persistedState, sessionId);
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
    const created = createEmptySessionState();
    input.state.sessionWorkbench[sessionId] = created;
    return created;
  }

  function getCurrentSessionState(): SessionWorkbenchState {
    return ensureSessionState(input.state.activeSessionId);
  }

  function sortModifiedFiles(files: ModifiedFileEntry[]): ModifiedFileEntry[] {
    return [...files].sort((a, b) => a.path.localeCompare(b.path));
  }

  function mergeModifiedFiles(existing: ModifiedFileEntry[], next: ModifiedFileEntry[]): ModifiedFileEntry[] {
    if (next.length === 0) {
      return existing;
    }
    const merged = new Map<string, ModifiedFileEntry>();
    for (const file of existing) {
      merged.set(file.path, file);
    }
    for (const file of next) {
      merged.set(file.path, file);
    }
    return sortModifiedFiles(Array.from(merged.values()));
  }

  function upsertTaskGroup(sessionState: SessionWorkbenchState, taskId: string, tasks: WorkbenchTaskItem[]): void {
    if (tasks.length === 0) {
      return;
    }
    const planHeader = tasks.find((task) => task.kind === "plan" && !task.parentGroupId);
    if (planHeader && !planHeader.originCheckpointId) {
      const hasPlanChildren = tasks.some((task) => task.parentGroupId === planHeader.id);
      // Only drop clearly-invalid empty plan headers.
      if (!hasPlanChildren) {
        return;
      }
    }
    const now = new Date().toISOString();
    const existingIndex = sessionState.taskGroups.findIndex((group) => group.taskId === taskId);
    const fallbackIndex = existingIndex >= 0 ? existingIndex + 1 : sessionState.taskGroups.length + 1;
    const nextGroup: SessionWorkbenchTaskGroup = {
      taskId,
      title: deriveTaskGroupTitle(tasks, fallbackIndex),
      tasks,
      updatedAt: now
    };
    if (existingIndex >= 0) {
      sessionState.taskGroups[existingIndex] = nextGroup;
      return;
    }
    sessionState.taskGroups.push(nextGroup);
  }

  function renderPanelState(taskGroups: SessionWorkbenchTaskGroup[], files: ModifiedFileEntry[]): void {
    const hasTasks = taskGroups.length > 0;
    const hasFiles = files.length > 0;
    input.tasksPanel.classList.toggle("hidden", !hasTasks);
    input.filesPanel.classList.toggle("hidden", !hasFiles);
    input.tasksPanel.classList.toggle("expanded", input.state.tasksExpanded && hasTasks);
    input.filesPanel.classList.toggle("expanded", input.state.filesExpanded && hasFiles);
    input.tasksCount.setAttribute("data-count", String(taskGroups.length));
    input.filesCount.setAttribute("data-count", String(files.length));
  }

  function closeAllPopovers(): void {
    input.state.tasksExpanded = false;
    input.state.filesExpanded = false;
  }

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

  function renderTaskEntries(tasks: WorkbenchTaskItem[]): HTMLDivElement {
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

    const container = document.createElement("div");
    container.className = "workbench-task-list";

    for (const header of groupHeaders) {
      const isCollapsed = collapsedPlanGroups.has(header.id);
      const children = groupChildren.get(header.id) ?? [];

      const group = document.createElement("div");
      group.className = `workbench-task-group${isCollapsed ? " collapsed" : ""}`;

      const groupHeader = document.createElement("div");
      groupHeader.className = "workbench-task-group-header";
      groupHeader.addEventListener("click", () => {
        if (collapsedPlanGroups.has(header.id)) {
          collapsedPlanGroups.delete(header.id);
        } else {
          collapsedPlanGroups.add(header.id);
        }
        renderCurrentSessionWorkbench();
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

    return container;
  }

  function summarizeTaskGroup(group: SessionWorkbenchTaskGroup): {
    status: "pending" | "running" | "done" | "failed";
    doneCount: number;
    totalCount: number;
  } {
    if (group.tasks.length === 0) {
      return { status: "pending", doneCount: 0, totalCount: 0 };
    }
    const doneCount = group.tasks.filter((task) => task.status === "done").length;
    if (group.tasks.some((task) => task.status === "failed")) {
      return { status: "failed", doneCount, totalCount: group.tasks.length };
    }
    if (group.tasks.every((task) => task.status === "done")) {
      return { status: "done", doneCount, totalCount: group.tasks.length };
    }
    if (group.tasks.some((task) => task.status === "running")) {
      return { status: "running", doneCount, totalCount: group.tasks.length };
    }
    return { status: "pending", doneCount, totalCount: group.tasks.length };
  }

  function renderTasks(taskGroups: SessionWorkbenchTaskGroup[]): void {
    input.tasksCount.textContent = String(taskGroups.length);
    if (taskGroups.length === 0) {
      input.tasksBody.innerHTML = "";
      return;
    }

    const container = document.createElement("div");
    container.className = "workbench-task-list";

    for (const taskGroup of taskGroups) {
      const summary = summarizeTaskGroup(taskGroup);
      const isCollapsed = collapsedTaskGroups.has(taskGroup.taskId);
      const group = document.createElement("div");
      group.className = `workbench-task-group${isCollapsed ? " collapsed" : ""}`;

      const groupHeader = document.createElement("div");
      groupHeader.className = "workbench-task-group-header";
      groupHeader.addEventListener("click", () => {
        if (collapsedTaskGroups.has(taskGroup.taskId)) {
          collapsedTaskGroups.delete(taskGroup.taskId);
        } else {
          collapsedTaskGroups.add(taskGroup.taskId);
        }
        renderCurrentSessionWorkbench();
      });

      const arrow = document.createElement("span");
      arrow.className = "workbench-task-group-arrow";
      arrow.textContent = isCollapsed ? "+" : "-";

      const status = document.createElement("div");
      status.className = `workbench-task-status ${summary.status}`;
      status.textContent =
        summary.status === "done" ? "ok" : summary.status === "failed" ? "!" : summary.status === "running" ? "..." : "";

      const title = document.createElement("div");
      title.className = "workbench-task-group-title";
      title.textContent = taskGroup.title;

      const meta = document.createElement("span");
      meta.className = "workbench-task-group-meta";
      meta.textContent = `${summary.doneCount}/${summary.totalCount}`;

      groupHeader.append(arrow, status, title, meta);
      group.appendChild(groupHeader);

      if (!isCollapsed) {
        const groupBody = document.createElement("div");
        groupBody.className = "workbench-task-group-body";
        groupBody.appendChild(renderTaskEntries(taskGroup.tasks));
        group.appendChild(groupBody);
      }

      container.appendChild(group);
    }

    input.tasksBody.replaceChildren(container);
  }

  function renderFiles(files: ModifiedFileEntry[]): void {
    input.filesCount.textContent = String(files.length);
    if (files.length === 0) {
      input.filesBody.innerHTML = '';
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
    input.filesBody.replaceChildren(list);
  }

  function renderCurrentSessionWorkbench(): void {
    const current = getCurrentSessionState();
    renderTasks(current.taskGroups);
    renderFiles(current.modifiedFiles);
    renderPanelState(current.taskGroups, current.modifiedFiles);
  }

  function bind(): void {
    hydrateSessionWorkbenchFromStorage();

    input.tasksToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const opening = !input.state.tasksExpanded;
      closeAllPopovers();
      input.state.tasksExpanded = opening;
      renderCurrentSessionWorkbench();
    });

    input.filesToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const opening = !input.state.filesExpanded;
      closeAllPopovers();
      input.state.filesExpanded = opening;
      renderCurrentSessionWorkbench();
    });

    document.addEventListener("click", (e) => {
      if (!input.state.tasksExpanded && !input.state.filesExpanded) {
        return;
      }
      const target = e.target as Node;
      if (input.tasksPanel.contains(target) || input.filesPanel.contains(target)) {
        return;
      }
      closeAllPopovers();
      renderCurrentSessionWorkbench();
    });

    window.addEventListener("beforeunload", () => {
      flushPersistSessionWorkbench();
    });

    input.api.onTasks((data) => {
      upsertTaskGroup(ensureSessionState(data.sessionId), data.taskId, data.tasks);
      schedulePersistSessionWorkbench();
      renderCurrentSessionWorkbench();
    });

    input.api.onModifiedFiles((data) => {
      const sessionState = ensureSessionState(data.sessionId);
      sessionState.modifiedFiles = mergeModifiedFiles(sessionState.modifiedFiles, data.files);
      schedulePersistSessionWorkbench();
      renderCurrentSessionWorkbench();
    });

    renderCurrentSessionWorkbench();
  }

  function resetSessionWorkbench(sessionId: string): void {
    input.state.sessionWorkbench[sessionId] = createEmptySessionState();
    schedulePersistSessionWorkbench();
    renderCurrentSessionWorkbench();
  }

  function removeTaskGroupsByOrigin(sessionId: string, checkpointId: string): void {
    if (!checkpointId) {
      return;
    }
    const sessionState = ensureSessionState(sessionId);
    const removedTaskGroupIds = new Set<string>();
    const removedPlanHeaderIds = new Set<string>();
    const nextGroups: SessionWorkbenchTaskGroup[] = [];

    for (const group of sessionState.taskGroups) {
      const planHeader = group.tasks.find((task) => task.kind === "plan" && !task.parentGroupId);
      const matchesOrigin =
        planHeader?.originCheckpointId === checkpointId ||
        group.taskId === checkpointId;
      if (matchesOrigin) {
        removedTaskGroupIds.add(group.taskId);
        if (planHeader) {
          removedPlanHeaderIds.add(planHeader.id);
        }
        continue;
      }
      nextGroups.push(group);
    }

    if (removedTaskGroupIds.size === 0) {
      return;
    }

    sessionState.taskGroups = nextGroups;
    for (const taskGroupId of removedTaskGroupIds) {
      collapsedTaskGroups.delete(taskGroupId);
    }
    for (const planHeaderId of removedPlanHeaderIds) {
      collapsedPlanGroups.delete(planHeaderId);
    }
    schedulePersistSessionWorkbench();
    renderCurrentSessionWorkbench();
  }

  return {
    bind,
    renderCurrentSessionWorkbench,
    resetSessionWorkbench,
    removeTaskGroupsByOrigin
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
