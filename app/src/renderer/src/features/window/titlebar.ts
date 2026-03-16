import type { TuanziAPI } from "../../../../shared/ipc-contracts";

interface TitlebarDeps {
  topBar: HTMLElement | null;
  topBarDrag: HTMLElement | null;
  windowControls: HTMLDivElement;
  windowMinimizeBtn: HTMLButtonElement;
  windowMaximizeBtn: HTMLButtonElement;
  windowCloseBtn: HTMLButtonElement;
  defaultTitlebarHeight: number;
  flushSessionsToStorage: () => void;
  api: Pick<
    TuanziAPI,
    "isWindowMaximized" | "minimizeWindow" | "toggleMaximizeWindow" | "closeWindow" | "onWindowMaximizedChanged"
  >;
}

function isWindowsPlatform(): boolean {
  return /Windows/i.test(navigator.userAgent);
}

function setWindowMaximizedState(windowMaximizeBtn: HTMLButtonElement, maximized: boolean): void {
  windowMaximizeBtn.classList.toggle("is-maximized", maximized);
  windowMaximizeBtn.title = maximized ? "还原" : "最大化";
}

async function refreshWindowMaximizedState(input: TitlebarDeps): Promise<void> {
  const result = await input.api.isWindowMaximized();
  if (!result.ok) {
    return;
  }
  setWindowMaximizedState(input.windowMaximizeBtn, result.maximized === true);
}

export function bindTitlebarWindowControls(input: TitlebarDeps): void {
  if (!input.topBar || !input.topBarDrag) {
    return;
  }
  document.documentElement.style.setProperty("--titlebar-height", `${input.defaultTitlebarHeight}px`);
  const isWindows = isWindowsPlatform();
  document.documentElement.classList.toggle("platform-windows", isWindows);
  input.windowControls.hidden = !isWindows;
  if (!isWindows) {
    return;
  }

  input.windowMinimizeBtn.addEventListener("click", () => {
    void input.api.minimizeWindow();
  });
  input.windowMaximizeBtn.addEventListener("click", () => {
    void input.api.toggleMaximizeWindow();
  });
  input.windowCloseBtn.addEventListener("click", () => {
    void input.api.closeWindow();
  });

  input.topBar.addEventListener("dblclick", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }
    if (target.closest(".top-bar-btn, .window-controls, .workspace-label, .agent-chip, button, input, textarea, select, a")) {
      return;
    }
    void input.api.toggleMaximizeWindow();
  });

  const removeMaximizedListener = input.api.onWindowMaximizedChanged((payload) => {
    setWindowMaximizedState(input.windowMaximizeBtn, payload.maximized === true);
  });
  window.addEventListener(
    "beforeunload",
    () => {
      removeMaximizedListener();
      input.flushSessionsToStorage();
    },
    { once: true }
  );
  void refreshWindowMaximizedState(input);
}
