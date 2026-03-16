import type { McpDashboardServer } from "../../../../shared/domain-types";
import type { TuanziAPI } from "../../../../shared/ipc-contracts";

interface McpSettingsState {
  mcpServers: McpDashboardServer[];
  expandedMcpServerIds: Set<string>;
  isMcpLoading: boolean;
  hasLoadedMcp: boolean;
  mcpLoadToken: number;
}

interface McpSettingsDeps {
  state: McpSettingsState;
  mcpServerList: HTMLDivElement;
  mcpJsonModal: HTMLDivElement;
  mcpJsonInput: HTMLTextAreaElement;
  escapeHtml: (text: string) => string;
  showError: (message: string) => void;
  getWorkspace: () => string;
  api: Pick<TuanziAPI, "getMcpDashboard" | "setMcpServerEnabled" | "mergeMcpJson">;
}

export interface McpSettingsController {
  renderMcpServers: () => void;
  refreshMcpServers: () => Promise<void>;
  toggleMcpServer: (serverId: string, enabled: boolean) => Promise<void>;
  openMcpJsonModal: () => void;
  closeMcpJsonModal: () => void;
  saveMcpJsonConfig: () => Promise<void>;
}

export function createMcpSettingsController(input: McpSettingsDeps): McpSettingsController {
  const renderMcpServers = (): void => {
    input.mcpServerList.innerHTML = "";
    if (input.state.isMcpLoading) {
      const loading = document.createElement("div");
      loading.className = "mcp-empty";
      loading.textContent = "加载中，正在探测 MCP Server 状态...";
      input.mcpServerList.appendChild(loading);
      return;
    }
    if (!input.state.hasLoadedMcp) {
      const empty = document.createElement("div");
      empty.className = "mcp-empty";
      empty.textContent = "进入此页面后点击“刷新”以加载 MCP Server 状态。";
      input.mcpServerList.appendChild(empty);
      return;
    }
    if (input.state.mcpServers.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mcp-empty";
      empty.textContent = "尚未配置 MCP Server，点击右上角“+ 添加”导入 JSON。";
      input.mcpServerList.appendChild(empty);
      return;
    }

    for (const server of input.state.mcpServers) {
      const card = document.createElement("div");
      card.className = "mcp-card";
      const isExpanded = input.state.expandedMcpServerIds.has(server.serverId);
      if (isExpanded) {
        card.classList.add("expanded");
      }

      const statusClass = server.status;
      const commandPreview = [server.command, ...server.args].join(" ");
      const toolsHtml =
        server.tools.length > 0
          ? server.tools
              .map((tool) => {
                return `<div class="mcp-tool-row">
                <div class="mcp-tool-name">${input.escapeHtml(tool.name)}</div>
                <div class="mcp-tool-desc">${input.escapeHtml(tool.description || "-")}</div>
              </div>`;
              })
              .join("")
          : '<div class="mcp-tool-row"><div class="mcp-tool-desc">无可用工具</div></div>';

      card.innerHTML = `
      <div class="mcp-card-head">
        <div class="mcp-chevron">></div>
        <div class="mcp-status-dot ${statusClass}"></div>
        <div class="mcp-title">
          <div class="mcp-title-text">${input.escapeHtml(server.serverId)}</div>
          <div class="mcp-subtitle">${input.escapeHtml(commandPreview || "(empty)")}</div>
          ${server.error ? `<div class="mcp-error">${input.escapeHtml(server.error)}</div>` : ""}
        </div>
        <button class="toggle-switch" data-enabled="${server.enabled ? "true" : "false"}"></button>
      </div>
      <div class="mcp-card-tools">${toolsHtml}</div>
    `;

      const head = card.querySelector(".mcp-card-head") as HTMLDivElement;
      head.addEventListener("click", () => {
        if (input.state.expandedMcpServerIds.has(server.serverId)) {
          input.state.expandedMcpServerIds.delete(server.serverId);
        } else {
          input.state.expandedMcpServerIds.add(server.serverId);
        }
        renderMcpServers();
      });

      const toggle = card.querySelector(".toggle-switch") as HTMLButtonElement;
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        void toggleMcpServer(server.serverId, !server.enabled);
      });

      input.mcpServerList.appendChild(card);
    }
  };

  const refreshMcpServers = async (): Promise<void> => {
    const requestToken = ++input.state.mcpLoadToken;
    input.state.isMcpLoading = true;
    renderMcpServers();

    const workspace = input.getWorkspace();
    const result = await input.api.getMcpDashboard({ workspace });

    if (requestToken !== input.state.mcpLoadToken) {
      return;
    }
    input.state.isMcpLoading = false;
    input.state.hasLoadedMcp = true;
    if (!result.ok || !result.mcp) {
      input.showError(result.error || "读取 MCP 配置失败");
      renderMcpServers();
      return;
    }
    input.state.mcpServers = result.mcp.servers;
    renderMcpServers();
  };

  const toggleMcpServer = async (serverId: string, enabled: boolean): Promise<void> => {
    const result = await input.api.setMcpServerEnabled({ serverId, enabled });
    if (!result.ok) {
      input.showError(result.error || "切换 MCP Server 失败");
      return;
    }
    await refreshMcpServers();
  };

  const openMcpJsonModal = (): void => {
    input.mcpJsonModal.classList.add("visible");
    input.mcpJsonInput.focus();
  };

  const closeMcpJsonModal = (): void => {
    input.mcpJsonModal.classList.remove("visible");
  };

  const saveMcpJsonConfig = async (): Promise<void> => {
    const jsonText = input.mcpJsonInput.value.trim();
    if (!jsonText) {
      input.showError("请输入 MCP JSON 配置");
      return;
    }
    const result = await input.api.mergeMcpJson({ jsonText });
    if (!result.ok) {
      input.showError(result.error || "保存 MCP JSON 配置失败");
      return;
    }
    closeMcpJsonModal();
    await refreshMcpServers();
  };

  return {
    renderMcpServers,
    refreshMcpServers,
    toggleMcpServer,
    openMcpJsonModal,
    closeMcpJsonModal,
    saveMcpJsonConfig
  };
}
