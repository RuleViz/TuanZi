import type { AgentEditorState } from "../../app/state";

interface AgentEditorEventState {
  editor: Pick<AgentEditorState, "mode" | "filenameTouched">;
}

interface AgentEditorEventsDeps {
  state: AgentEditorEventState;
  agentEditorName: HTMLInputElement;
  agentEditorFilename: HTMLInputElement;
  agentEditorAvatarInput: HTMLInputElement;
  slugifyAsFilename: (input: string) => string;
  updateEditorAvatarPreview: () => void;
}

export function bindAgentEditorEvents(input: AgentEditorEventsDeps): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".agent-tab"));
  const panels = Array.from(document.querySelectorAll<HTMLElement>(".agent-panel"));
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      tabs.forEach((item) => item.classList.toggle("active", item === tab));
      panels.forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.panel === target);
      });
    });
  });

  input.agentEditorName.addEventListener("input", () => {
    if (input.state.editor.mode === "create" && !input.state.editor.filenameTouched) {
      input.agentEditorFilename.value = input.slugifyAsFilename(input.agentEditorName.value);
    }
    input.updateEditorAvatarPreview();
  });
  input.agentEditorFilename.addEventListener("input", () => {
    input.state.editor.filenameTouched = true;
  });
  input.agentEditorAvatarInput.addEventListener("input", input.updateEditorAvatarPreview);
}
