export type GlobalSkillCategory = "file_system" | "execute_command" | "web_search";

export interface AgentProviderConfig {
  type: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export type ProviderModelProtocolType =
  | "openai_chat_completions"
  | "openai_responses"
  | "anthropic_messages"
  | "gemini_generate_content"
  | "custom";

export type ProviderModelTokenEstimatorType = "builtin" | "remote_exact" | "heuristic";

export interface ProviderModelItem {
  id: string;
  displayName: string;
  isVision: boolean;
  enabled: boolean;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  protocolType: ProviderModelProtocolType;
  tokenEstimatorType?: ProviderModelTokenEstimatorType;
}

export interface ProviderConfig extends AgentProviderConfig {
  id: string;
  name: string;
  models: ProviderModelItem[];
  isEnabled: boolean;
}

export interface AgentBackendConfig {
  provider: AgentProviderConfig;
  providers: ProviderConfig[];
  activeProviderId: string;
}

export interface SkillCatalogItem {
  name: string;
  description: string;
  rootDir: string;
  skillDir: string;
  skillFile: string;
}

export interface StoredAgent {
  id: string;
  filename: string;
  name: string;
  avatar: string;
  description: string;
  tags: string[];
  tools: string[];
  prompt: string;
}

export interface AgentToolProfile {
  name: string;
  category: GlobalSkillCategory;
  prompt: string;
}

export interface AgentSavePayload {
  previousFilename?: string | null;
  filename?: string | null;
  name: string;
  avatar?: string | null;
  description?: string | null;
  tags?: string[];
  tools?: string[];
  prompt: string;
}

export interface ChatImageInput {
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface McpDashboardTool {
  name: string;
  description: string;
  namespacedName: string;
}

export interface McpDashboardServer {
  serverId: string;
  enabled: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  status: "online" | "offline" | "error";
  error?: string;
  tools: McpDashboardTool[];
}

export interface TurnCheckpointInfo {
  id: string;
  turnIndex: number;
  userMessage: string;
  createdAt: string;
  toolCalls: string[];
}
