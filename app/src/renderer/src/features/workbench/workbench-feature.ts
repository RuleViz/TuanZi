import type {
  ModifiedFileEntry,
  TerminalSessionSummary,
  TuanziAPI,
  WorkbenchTaskItem
} from "../../../../shared/ipc-contracts";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { SessionWorkbenchState, WorkbenchTerminalState } from "../../app/state";

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
  terminalsCount: HTMLSpanElement;
  filesCount: HTMLSpanElement;
  filesContainer: HTMLDivElement;
  terminalTabs: HTMLDivElement;
  terminalPanel: HTMLDivElement;
  pageButtons: HTMLButtonElement[];
  toggleButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
  newTerminalButton: HTMLButtonElement;
  showError: (message: string) => void;
  api: Pick<
    TuanziAPI,
    | "createTerminal"
    | "writeTerminal"
    | "resizeTerminal"
    | "closeTerminal"
    | "onTasks"
    | "onModifiedFiles"
    | "onTerminalOpened"
    | "onTerminalData"
    | "onTerminalExit"
    | "onTerminalClosed"
  >;
}

export interface WorkbenchFeature {
  bind: () => void;
  renderCurrentSessionWorkbench: () => void;
  resetSessionWorkbench: (sessionId: string) => void;
}

interface ActiveTerminalView {
  terminalId: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  renderedOutputLength: number;
  disposeInput: () => void;
}

type WorkbenchPage = "tasks" | "terminals" | "files";
const WORKBENCH_STORAGE_KEY = "tuanzi.desktop.workbench.v1";
const WORKBENCH_PERSIST_DEBOUNCE_MS = 180;

interface PersistedWorkbenchTerminalState {
  terminalId: string;
  title: string;
  workspace: string;
  status: "running" | "exited" | "closed";
  createdAt: string;
  exitCode?: number | null;
}

interface PersistedWorkbenchSessionState {
  tasks: WorkbenchTaskItem[];
  terminals: PersistedWorkbenchTerminalState[];
  modifiedFiles: ModifiedFileEntry[];
  selectedTerminalId: string | null;
}

interface PersistedWorkbenchPayload {
  version: 1;
  sessions: Record<string, PersistedWorkbenchSessionState>;
}

export function createWorkbenchFeature(input: WorkbenchFeatureDeps): WorkbenchFeature {
  let activeTerminalView: ActiveTerminalView | null = null;
  let resizeFitTimer: number | null = null;
  let persistTimer: number | null = null;
  let activePage: WorkbenchPage = "tasks";

  function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function toPersistedTerminal(terminal: WorkbenchTerminalState): PersistedWorkbenchTerminalState {
    return {
      terminalId: terminal.terminalId,
      title: terminal.title,
      workspace: terminal.workspace,
      status: terminal.status,
      createdAt: terminal.createdAt,
      ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {})
    };
  }

  function toPersistedSessionState(state: SessionWorkbenchState): PersistedWorkbenchSessionState {
    return {
      tasks: state.tasks,
      terminals: state.terminals.map(toPersistedTerminal),
      modifiedFiles: state.modifiedFiles,
      selectedTerminalId: state.selectedTerminalId
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

  function normalizeTerminal(
    value: unknown,
    sessionId: string
  ): WorkbenchTerminalState | null {
    if (!isRecord(value)) {
      return null;
    }
    if (
      typeof value.terminalId !== "string" ||
      typeof value.title !== "string" ||
      typeof value.workspace !== "string" ||
      typeof value.createdAt !== "string"
    ) {
      return null;
    }
    if (value.status !== "running" && value.status !== "exited" && value.status !== "closed") {
      return null;
    }
    const exitCode =
      typeof value.exitCode === "number" && Number.isFinite(value.exitCode)
        ? Math.floor(value.exitCode)
        : value.exitCode === null
          ? null
          : undefined;
    return {
      terminalId: value.terminalId,
      sessionId,
      title: value.title,
      workspace: value.workspace,
      status: value.status === "running" ? "closed" : value.status,
      createdAt: value.createdAt,
      ...(exitCode !== undefined ? { exitCode } : {}),
      output: ""
    };
  }

  function normalizePersistedSessionState(
    value: unknown,
    sessionId: string
  ): SessionWorkbenchState | null {
    if (!isRecord(value)) {
      return null;
    }
    const tasks = Array.isArray(value.tasks) ? value.tasks.map(normalizeTask).filter((item): item is WorkbenchTaskItem => item !== null) : [];
    const terminals = Array.isArray(value.terminals)
      ? value.terminals.map((item) => normalizeTerminal(item, sessionId)).filter((item): item is WorkbenchTerminalState => item !== null)
      : [];
    const modifiedFiles = Array.isArray(value.modifiedFiles)
      ? value.modifiedFiles.map(normalizeModifiedFile).filter((item): item is ModifiedFileEntry => item !== null)
      : [];
    const selectedTerminalId = typeof value.selectedTerminalId === "string" ? value.selectedTerminalId : null;
    return {
      tasks,
      terminals,
      modifiedFiles,
      selectedTerminalId: selectedTerminalId && terminals.some((terminal) => terminal.terminalId === selectedTerminalId)
        ? selectedTerminalId
        : terminals[0]?.terminalId ?? null
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
    const created: SessionWorkbenchState = {
      tasks: [],
      terminals: [],
      modifiedFiles: [],
      selectedTerminalId: null
    };
    input.state.sessionWorkbench[sessionId] = created;
    return created;
  }

  function getCurrentSessionState(): SessionWorkbenchState {
    return ensureSessionState(input.state.activeSessionId);
  }

  function disposeActiveTerminalView(): void {
    if (!activeTerminalView) {
      return;
    }
    activeTerminalView.disposeInput();
    activeTerminalView.terminal.dispose();
    activeTerminalView = null;
  }

  function applyTerminalHead(selected: WorkbenchTerminalState): void {
    const title = input.terminalPanel.querySelector(".workbench-terminal-head .workbench-task-title") as HTMLDivElement | null;
    const status = input.terminalPanel.querySelector(".workbench-terminal-status") as HTMLSpanElement | null;
    if (title) {
      title.textContent = selected.title;
    }
    if (status) {
      status.className = `workbench-terminal-status ${selected.status}`;
      status.textContent = selected.status === "running" ? "RUNNING" : selected.status === "exited" ? `EXIT ${selected.exitCode ?? "null"}` : "CLOSED";
    }
  }

  function fitActiveTerminal(): void {
    if (!activeTerminalView) {
      return;
    }
    try {
      activeTerminalView.fitAddon.fit();
    } catch {
      return;
    }
    void input.api
      .resizeTerminal({
        terminalId: activeTerminalView.terminalId,
        cols: activeTerminalView.terminal.cols,
        rows: activeTerminalView.terminal.rows
      })
      .catch(() => {
        return;
      });
  }

  function scheduleFit(delay = 0): void {
    if (resizeFitTimer !== null) {
      window.clearTimeout(resizeFitTimer);
    }
    resizeFitTimer = window.setTimeout(() => {
      resizeFitTimer = null;
      fitActiveTerminal();
    }, delay);
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
    input.toggleButton.title = isOpen ? "收起工作台" : "展开工作台";
    if (isOpen) {
      scheduleFit(320);
    }
  }

  const collapsedGroups = new Set<string>();

  function renderTaskItem(task: WorkbenchTaskItem): HTMLDivElement {
    const item = document.createElement("div");
    item.className = "workbench-task-item";

    const status = document.createElement("div");
    status.className = `workbench-task-status ${task.status}`;
    status.textContent = task.status === "done" ? "✓" : task.status === "failed" ? "!" : task.status === "running" ? "..." : "";

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
    const groupHeaders = tasks.filter((t) => !t.parentGroupId && t.kind === "plan");
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
      arrow.textContent = isCollapsed ? "▶" : "▼";

      const headerStatus = document.createElement("div");
      headerStatus.className = `workbench-task-status ${header.status}`;
      headerStatus.textContent = header.status === "done" ? "✓" : header.status === "failed" ? "!" : header.status === "running" ? "..." : "";

      const headerTitle = document.createElement("div");
      headerTitle.className = "workbench-task-group-title";
      headerTitle.textContent = header.title;

      const headerMeta = document.createElement("span");
      headerMeta.className = "workbench-task-group-meta";
      const doneCount = children.filter((c) => c.status === "done").length;
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

  let terminalModalOverlay: HTMLDivElement | null = null;
  let terminalModalXterm: { terminalId: string; terminal: Terminal; fitAddon: FitAddon; inputDisposable: { dispose(): void } } | null = null;

  function closeTerminalModal(): void {
    if (terminalModalXterm) {
      terminalModalXterm.inputDisposable.dispose();
      terminalModalXterm.terminal.dispose();
      terminalModalXterm = null;
    }
    if (terminalModalOverlay) {
      terminalModalOverlay.remove();
      terminalModalOverlay = null;
    }
  }

  function openTerminalModal(
    selected: WorkbenchTerminalState | null
  ): void {
    if (!selected) return;
    closeTerminalModal();

    const overlay = document.createElement("div");
    overlay.className = "terminal-modal-overlay";
    overlay.innerHTML = `
      <div class="terminal-modal">
        <div class="terminal-modal-header">
          <div class="terminal-modal-header-left">
            <span class="terminal-modal-title"></span>
            <span class="workbench-terminal-status"></span>
          </div>
          <button class="terminal-modal-close" title="关闭">×</button>
        </div>
        <div class="terminal-modal-body">
          <div class="terminal-modal-xterm"></div>
        </div>
      </div>
    `;

    const titleEl = overlay.querySelector(".terminal-modal-title") as HTMLSpanElement;
    titleEl.textContent = selected.title;
    const statusEl = overlay.querySelector(".workbench-terminal-status") as HTMLSpanElement;
    statusEl.className = `workbench-terminal-status ${selected.status}`;
    statusEl.textContent = selected.status === "running" ? "RUNNING" : selected.status === "exited" ? `EXIT ${selected.exitCode ?? "null"}` : "CLOSED";

    const closeBtn = overlay.querySelector(".terminal-modal-close") as HTMLButtonElement;
    closeBtn.addEventListener("click", closeTerminalModal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeTerminalModal();
    });

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        closeTerminalModal();
        window.removeEventListener("keydown", onKey);
      }
    };
    window.addEventListener("keydown", onKey);

    document.body.appendChild(overlay);
    terminalModalOverlay = overlay;

    const xtermHost = overlay.querySelector(".terminal-modal-xterm") as HTMLDivElement;
    const modalTerminal = new Terminal({
      convertEol: true,
      allowTransparency: true,
      cursorBlink: true,
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      lineHeight: 1.42,
      letterSpacing: 0.2,
      scrollback: 5000,
      theme: {
        background: "#0C0C0C",
        foreground: "#EDEDED",
        cursor: "#FF8D2A",
        selectionBackground: "rgba(255, 122, 0, 0.22)",
        black: "#0C0C0C",
        brightBlack: "#5B5B5B",
        red: "#FF6D6F",
        brightRed: "#FF8D8E",
        green: "#8DDA63",
        brightGreen: "#A9F57F",
        yellow: "#F5C66D",
        brightYellow: "#FFD88A",
        blue: "#73B8FF",
        brightBlue: "#9BCFFF",
        magenta: "#C39BFF",
        brightMagenta: "#D7BCFF",
        cyan: "#6EE7D8",
        brightCyan: "#94F7EB",
        white: "#EDEDED",
        brightWhite: "#FFFFFF"
      }
    });
    const modalFit = new FitAddon();
    modalTerminal.loadAddon(modalFit);
    modalTerminal.open(xtermHost);

    if (selected.output) {
      modalTerminal.write(selected.output);
    }

    modalTerminal.options.disableStdin = selected.status !== "running";

    const terminalId = selected.terminalId;
    const inputDisposable = modalTerminal.onData((data) => {
      const current = getCurrentSessionState().terminals.find((item) => item.terminalId === terminalId);
      if (!current || current.status !== "running") return;
      void input.api.writeTerminal({ terminalId, data }).catch((error) => {
        input.showError(error instanceof Error ? error.message : String(error));
      });
    });

    xtermHost.addEventListener("mousedown", () => { modalTerminal.focus(); });

    terminalModalXterm = { terminalId: selected.terminalId, terminal: modalTerminal, fitAddon: modalFit, inputDisposable };

    requestAnimationFrame(() => {
      try { modalFit.fit(); } catch { /* ignore */ }
      modalTerminal.focus();
    });
  }

  function getSelectedTerminal(state: SessionWorkbenchState): WorkbenchTerminalState | null {
    if (state.terminals.length === 0) {
      return null;
    }
    const picked = state.selectedTerminalId
      ? state.terminals.find((terminal) => terminal.terminalId === state.selectedTerminalId) ?? null
      : null;
    return picked ?? state.terminals[0] ?? null;
  }

  function renderTerminals(state: SessionWorkbenchState): void {
    input.terminalsCount.textContent = String(state.terminals.length);
    input.newTerminalButton.disabled = !input.state.activeSessionId;
    input.terminalTabs.innerHTML = "";

    const selected = getSelectedTerminal(state);
    state.selectedTerminalId = selected?.terminalId ?? null;

    if (state.terminals.length === 0 || !selected) {
      disposeActiveTerminalView();
      input.terminalPanel.innerHTML = '<div class="workbench-empty">当前会话还没有终端</div>';
      return;
    }

    for (const terminal of state.terminals) {
      const tab = document.createElement("div");
      tab.className = `workbench-terminal-tab${terminal.terminalId === selected.terminalId ? " active" : ""}`;
      tab.tabIndex = 0;
      tab.innerHTML = `
        <span class="workbench-terminal-tab-label">${escapeHtml(terminal.title)}</span>
        <button class="workbench-terminal-close" title="关闭终端">×</button>
      `;
      const closeBtn = tab.querySelector(".workbench-terminal-close") as HTMLButtonElement;
      closeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void closeTerminal(terminal.terminalId);
      });
      tab.addEventListener("click", () => {
        state.selectedTerminalId = terminal.terminalId;
        renderCurrentSessionWorkbench();
      });
      tab.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          state.selectedTerminalId = terminal.terminalId;
          renderCurrentSessionWorkbench();
        }
      });
      input.terminalTabs.appendChild(tab);
    }

    if (!activeTerminalView || activeTerminalView.terminalId !== selected.terminalId) {
      disposeActiveTerminalView();

      const view = document.createElement("div");
      view.className = "workbench-terminal-view";
      view.innerHTML = `
        <div class="workbench-terminal-head">
          <div class="workbench-terminal-head-left">
            <div class="workbench-task-title"></div>
            <span class="workbench-terminal-status"></span>
          </div>
          <div class="workbench-terminal-head-actions">
            <button class="workbench-terminal-head-btn" data-action="maximize" title="放大终端">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5.828 10.172a.5.5 0 0 0-.707 0l-4.096 4.096V11.5a.5.5 0 0 0-1 0v3.975a.5.5 0 0 0 .5.5H4.5a.5.5 0 0 0 0-1H1.732l4.096-4.096a.5.5 0 0 0 0-.707zm4.344-4.344a.5.5 0 0 0 .707 0l4.096-4.096V4.5a.5.5 0 1 0 1 0V.525a.5.5 0 0 0-.5-.5H11.5a.5.5 0 0 0 0 1h2.768l-4.096 4.096a.5.5 0 0 0 0 .707z"/></svg>
            </button>
          </div>
        </div>
        <div class="workbench-terminal-native">
          <div class="workbench-terminal-xterm"></div>
        </div>
      `;

      const maximizeBtn = view.querySelector("[data-action='maximize']") as HTMLButtonElement;
      maximizeBtn.addEventListener("click", () => {
        if (!activeTerminalView) return;
        const sel = getSelectedTerminal(getCurrentSessionState());
        openTerminalModal(sel);
      });

      input.terminalPanel.replaceChildren(view);

      const xtermHost = view.querySelector(".workbench-terminal-xterm") as HTMLDivElement;
      const terminal = new Terminal({
        convertEol: true,
        allowTransparency: true,
        cursorBlink: true,
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        lineHeight: 1.42,
        letterSpacing: 0.2,
        scrollback: 3000,
        theme: {
          background: "#0C0C0C",
          foreground: "#EDEDED",
          cursor: "#FF8D2A",
          selectionBackground: "rgba(255, 122, 0, 0.22)",
          black: "#0C0C0C",
          brightBlack: "#5B5B5B",
          red: "#FF6D6F",
          brightRed: "#FF8D8E",
          green: "#8DDA63",
          brightGreen: "#A9F57F",
          yellow: "#F5C66D",
          brightYellow: "#FFD88A",
          blue: "#73B8FF",
          brightBlue: "#9BCFFF",
          magenta: "#C39BFF",
          brightMagenta: "#D7BCFF",
          cyan: "#6EE7D8",
          brightCyan: "#94F7EB",
          white: "#EDEDED",
          brightWhite: "#FFFFFF"
        }
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(xtermHost);

      const terminalId = selected.terminalId;
      const inputDisposable = terminal.onData((data) => {
        const current = getCurrentSessionState().terminals.find((item) => item.terminalId === terminalId);
        if (!current || current.status !== "running") {
          return;
        }
        void input.api.writeTerminal({ terminalId, data }).catch((error) => {
          input.showError(error instanceof Error ? error.message : String(error));
        });
      });

      xtermHost.addEventListener("mousedown", () => {
        terminal.focus();
      });

      activeTerminalView = {
        terminalId: selected.terminalId,
        terminal,
        fitAddon,
        renderedOutputLength: 0,
        disposeInput: () => {
          inputDisposable.dispose();
        }
      };

      requestAnimationFrame(() => {
        terminal.focus();
        scheduleFit();
      });
    }

    applyTerminalHead(selected);

    if (!activeTerminalView) {
      return;
    }

    activeTerminalView.terminal.options.disableStdin = selected.status !== "running";

    if (selected.output.length < activeTerminalView.renderedOutputLength) {
      activeTerminalView.terminal.reset();
      activeTerminalView.terminal.write(selected.output);
      activeTerminalView.renderedOutputLength = selected.output.length;
      return;
    }

    if (selected.output.length > activeTerminalView.renderedOutputLength) {
      const delta = selected.output.slice(activeTerminalView.renderedOutputLength);
      activeTerminalView.terminal.write(delta);
      activeTerminalView.renderedOutputLength = selected.output.length;
    }
  }

  async function createTerminal(): Promise<void> {
    const session = input.state.sessions.find((item) => item.id === input.state.activeSessionId);
    if (!session || !session.workspace) {
      input.showError("请先选择工作目录，再创建终端");
      return;
    }
    const result = await input.api.createTerminal({
      sessionId: session.id,
      workspace: session.workspace,
      title: `Terminal ${ensureSessionState(session.id).terminals.length + 1}`
    });
    if (!result.ok || !result.terminal) {
      input.showError(result.error || "创建终端失败");
      return;
    }
  }

  async function closeTerminal(terminalId: string): Promise<void> {
    const result = await input.api.closeTerminal({ terminalId });
    if (!result.ok) {
      removeTerminal(input.state.activeSessionId, terminalId);
      renderCurrentSessionWorkbench();
    }
  }

  function renderCurrentSessionWorkbench(): void {
    renderDrawerState();
    const current = getCurrentSessionState();
    renderTasks(current.tasks);
    renderTerminals(current);
    renderFiles(current.modifiedFiles);
  }

  function updateTerminalSummary(summary: TerminalSessionSummary): void {
    const state = ensureSessionState(summary.sessionId);
    const existing = state.terminals.find((item) => item.terminalId === summary.terminalId);
    if (existing) {
      existing.title = summary.title;
      existing.workspace = summary.workspace;
      existing.status = summary.status;
      existing.createdAt = summary.createdAt;
      existing.exitCode = summary.exitCode;
    } else {
      state.terminals.unshift({ ...summary, output: "" });
    }
    if (!state.selectedTerminalId) {
      state.selectedTerminalId = summary.terminalId;
    }
    schedulePersistSessionWorkbench();
  }

  function removeTerminal(sessionId: string, terminalId: string): void {
    const state = ensureSessionState(sessionId);
    state.terminals = state.terminals.filter((item) => item.terminalId !== terminalId);
    if (activeTerminalView?.terminalId === terminalId) {
      disposeActiveTerminalView();
    }
    if (state.selectedTerminalId === terminalId) {
      state.selectedTerminalId = state.terminals[0]?.terminalId ?? null;
    }
    schedulePersistSessionWorkbench();
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
    input.newTerminalButton.addEventListener("click", () => {
      void createTerminal();
    });
    window.addEventListener("resize", () => {
      scheduleFit();
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
    input.api.onTerminalOpened((data) => {
      updateTerminalSummary(data.terminal);
      renderCurrentSessionWorkbench();
    });
    input.api.onTerminalData((data) => {
      const state = ensureSessionState(data.sessionId);
      const terminal = state.terminals.find((item) => item.terminalId === data.terminalId);
      if (!terminal) {
        return;
      }
      terminal.output = `${terminal.output}${data.chunk}`.slice(-20000);
      // Write directly to xterm instances instead of triggering full re-render
      if (activeTerminalView && activeTerminalView.terminalId === data.terminalId) {
        activeTerminalView.terminal.write(data.chunk);
        activeTerminalView.renderedOutputLength = terminal.output.length;
      }
      if (terminalModalXterm && terminalModalXterm.terminalId === data.terminalId) {
        terminalModalXterm.terminal.write(data.chunk);
      }
    });
    input.api.onTerminalExit((data) => {
      const state = ensureSessionState(data.sessionId);
      const terminal = state.terminals.find((item) => item.terminalId === data.terminalId);
      if (!terminal) {
        return;
      }
      terminal.status = "exited";
      terminal.exitCode = data.exitCode;
      terminal.output = `${terminal.output}\n[process exited with code ${String(data.exitCode)}]\n`;
      schedulePersistSessionWorkbench();
      renderCurrentSessionWorkbench();
    });
    input.api.onTerminalClosed((data) => {
      removeTerminal(data.sessionId, data.terminalId);
      renderCurrentSessionWorkbench();
    });

    renderCurrentSessionWorkbench();
  }

  function resetSessionWorkbench(sessionId: string): void {
    input.state.sessionWorkbench[sessionId] = {
      tasks: [],
      terminals: ensureSessionState(sessionId).terminals,
      modifiedFiles: [],
      selectedTerminalId: ensureSessionState(sessionId).selectedTerminalId
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
