import type {
  ModifiedFileEntry,
  TerminalSessionSummary,
  TuanziAPI,
  WorkbenchTaskItem
} from "../../../../shared/ipc-contracts";
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
  toggleButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
  newTerminalButton: HTMLButtonElement;
  showError: (message: string) => void;
  api: Pick<
    TuanziAPI,
    | "createTerminal"
    | "writeTerminal"
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

export function createWorkbenchFeature(input: WorkbenchFeatureDeps): WorkbenchFeature {
  let sectionButtonsBound = false;

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

  function renderDrawerState(): void {
    input.drawer.classList.toggle("open", input.state.workbenchOpen);
    input.drawer.setAttribute("aria-hidden", input.state.workbenchOpen ? "false" : "true");
    input.toggleButton.classList.toggle("active", input.state.workbenchOpen);
    input.toggleButton.setAttribute("aria-expanded", input.state.workbenchOpen ? "true" : "false");
    input.toggleButton.title = input.state.workbenchOpen ? "收起工作台" : "展开工作台";
  }

  function renderTasks(tasks: WorkbenchTaskItem[]): void {
    input.tasksCount.textContent = String(tasks.length);
    if (tasks.length === 0) {
      input.tasksContainer.innerHTML = '<div class="workbench-empty">当前会话还没有任务记录</div>';
      return;
    }

    const list = document.createElement("div");
    list.className = "workbench-task-list";
    for (const task of tasks) {
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
      list.appendChild(item);
    }
    input.tasksContainer.replaceChildren(list);
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

    const output = selected.output.trim().length > 0 ? selected.output : "[terminal ready]";
    const view = document.createElement("div");
    view.className = "workbench-terminal-view";
    view.innerHTML = `
      <div class="workbench-terminal-head">
        <div>
          <div class="workbench-task-title">${escapeHtml(selected.title)}</div>
          <div class="workbench-terminal-meta">${escapeHtml(selected.workspace)} · ${selected.status}${
      selected.exitCode !== undefined ? ` · exit ${selected.exitCode ?? "null"}` : ""
    }</div>
        </div>
      </div>
      <pre class="workbench-terminal-output"></pre>
      <div class="workbench-terminal-input-row">
        <input class="workbench-terminal-input" type="text" placeholder="输入命令或交互内容，回车发送" />
        <button class="workbench-terminal-send">发送</button>
      </div>
    `;

    const outputEl = view.querySelector(".workbench-terminal-output") as HTMLPreElement;
    outputEl.textContent = output;
    outputEl.scrollTop = outputEl.scrollHeight;

    const inputEl = view.querySelector(".workbench-terminal-input") as HTMLInputElement;
    const sendBtn = view.querySelector(".workbench-terminal-send") as HTMLButtonElement;
    const terminalClosed = selected.status !== "running";
    inputEl.disabled = terminalClosed;
    sendBtn.disabled = terminalClosed;

    const submit = (): void => {
      const value = inputEl.value;
      if (!value) {
        return;
      }
      inputEl.value = "";
      void input.api.writeTerminal({ terminalId: selected.terminalId, data: `${value}\n` }).catch((error) => {
        input.showError(error instanceof Error ? error.message : String(error));
      });
    };
    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
    sendBtn.addEventListener("click", submit);

    input.terminalPanel.replaceChildren(view);
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
      input.showError(result.error || "关闭终端失败");
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
      state.terminals.unshift({ ...summary, output: `[terminal ready]\n` });
    }
    if (!state.selectedTerminalId) {
      state.selectedTerminalId = summary.terminalId;
    }
  }

  function removeTerminal(sessionId: string, terminalId: string): void {
    const state = ensureSessionState(sessionId);
    state.terminals = state.terminals.filter((item) => item.terminalId !== terminalId);
    if (state.selectedTerminalId === terminalId) {
      state.selectedTerminalId = state.terminals[0]?.terminalId ?? null;
    }
  }

  function bindSectionToggles(): void {
    if (sectionButtonsBound) {
      return;
    }
    sectionButtonsBound = true;
    const buttons = input.drawer.querySelectorAll<HTMLElement>("[data-workbench-toggle]");
    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        const section = button.closest(".workbench-section");
        section?.classList.toggle("expanded");
      });
    });
  }

  function bind(): void {
    bindSectionToggles();
    input.toggleButton.addEventListener("click", () => {
      input.state.workbenchOpen = !input.state.workbenchOpen;
      renderCurrentSessionWorkbench();
    });
    input.closeButton.addEventListener("click", () => {
      input.state.workbenchOpen = false;
      renderCurrentSessionWorkbench();
    });
    input.newTerminalButton.addEventListener("click", () => {
      void createTerminal();
    });

    input.api.onTasks((data) => {
      ensureSessionState(data.sessionId).tasks = data.tasks;
      renderCurrentSessionWorkbench();
    });
    input.api.onModifiedFiles((data) => {
      ensureSessionState(data.sessionId).modifiedFiles = data.files;
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
      renderCurrentSessionWorkbench();
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
