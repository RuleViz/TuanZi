import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findCustomModelConfig, loadCustomModelStore } from "./core/custom-model-store";
import type { ApprovalMode } from "./core/approval-gate";
import type { AgentSettings, JsonObject, PolicyDecision } from "./core/types";

export interface RuntimeConfig {
  workspaceRoot: string;
  approvalMode: ApprovalMode;
  agentSettings: AgentSettings;
  model: {
    keySource: "openai" | "none";
    baseUrl: string;
    apiKey: string | null;
    plannerModel: string | null;
    searchModel: string | null;
    coderModel: string | null;
  };
}

export function loadRuntimeConfig(input: {
  workspaceRoot?: string;
  approvalMode?: ApprovalMode;
  modelOverride?: string | null;
}): RuntimeConfig {
  const workspaceRoot = path.resolve(input.workspaceRoot ?? process.cwd());
  const approvalMode = input.approvalMode ?? "manual";
  const agentSettings = loadAgentSettings(workspaceRoot);
  const modelOverride = normalizeOptionalString(input.modelOverride ?? null);
  const customStore = loadCustomModelStore();
  const overrideCustomModel = modelOverride ? findCustomModelConfig(customStore, modelOverride) : null;
  const defaultCustomModel = modelOverride ? null : findCustomModelConfig(customStore, customStore.defaultModel);
  const selectedCustomModel = overrideCustomModel ?? defaultCustomModel;

  let keySource: RuntimeConfig["model"]["keySource"];
  let baseUrl: string;
  let apiKey: string | null;
  let plannerModel: string | null;
  let searchModel: string | null;
  let coderModel: string | null;

  if (selectedCustomModel) {
    keySource = "openai";
    baseUrl = selectedCustomModel.baseUrl;
    apiKey = selectedCustomModel.apiKey;
    plannerModel = selectedCustomModel.modelId;
    searchModel = selectedCustomModel.modelId;
    coderModel = selectedCustomModel.modelId;
  } else {
    keySource = "none";
    baseUrl = "https://api.openai.com/v1";
    apiKey = null;
    plannerModel = null;
    searchModel = null;
    coderModel = null;

    if (modelOverride && !overrideCustomModel) {
      console.warn(`[WARN] model override alias not found in custom model store: ${modelOverride}`);
    }
  }

  return {
    workspaceRoot,
    approvalMode,
    agentSettings,
    model: {
      keySource,
      baseUrl,
      apiKey,
      plannerModel,
      searchModel,
      coderModel
    }
  };
}
const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  routing: {
    enableDirectMode: true,
    defaultEnablePlanMode: false,
    directIntentPatterns: ["introduce", "explain", "who", "what", "why", "how"]
  },
  policy: {
    default: "allow",
    tools: {
      run_command: "ask",
      write_to_file: "ask",
      diff_apply: "ask",
      delete_file: "ask"
    },
    commandRules: {
      deny: ["/^rm -rf\\b/i", "/^format\\b/i", "/^mkfs\\b/i", "/^shutdown\\b/i", "git reset --hard"],
      allow: ["npm test", "npm run build", "echo", "git status"]
    }
  },
  webSearch: {
    enabled: true,
    provider: "mcp",
    maxUsesPerTask: 2,
    maxResultsPerUse: 5,
    maxCharsPerPage: 20000,
    cacheTtlMs: 10 * 60 * 1000
  },
  toolLoop: {
    searchMaxTurns: 12,
    coderMaxTurns: 20,
    noProgressRepeatTurns: 2
  },
  mcp: {
    enabled: false,
    command: "",
    args: [],
    env: {},
    tools: {
      webSearch: "web_search",
      fetchUrl: "fetch_url"
    },
    startupTimeoutMs: 15000,
    requestTimeoutMs: 30000
  }
};

export function loadAgentSettings(workspaceRoot: string): AgentSettings {
  const filePath = path.join(workspaceRoot, "agent.config.json");
  if (!existsSync(filePath)) {
    return cloneDefaultSettings();
  }

  let parsed: unknown;
  try {
    const content = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
    parsed = content ? (JSON.parse(content) as unknown) : {};
  } catch (error) {
    console.warn(
      `[WARN] Failed to parse agent.config.json, fallback to defaults: ${error instanceof Error ? error.message : String(error)
      }`
    );
    return cloneDefaultSettings();
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return cloneDefaultSettings();
  }

  return mergeAgentSettings(cloneDefaultSettings(), parsed as JsonObject);
}

function cloneDefaultSettings(): AgentSettings {
  return JSON.parse(JSON.stringify(DEFAULT_AGENT_SETTINGS)) as AgentSettings;
}

function mergeAgentSettings(base: AgentSettings, input: JsonObject): AgentSettings {
  const routingRaw = asObject(input.routing);
  if (routingRaw) {
    const enableDirectMode = asBoolean(routingRaw.enableDirectMode);
    if (enableDirectMode !== null) {
      base.routing.enableDirectMode = enableDirectMode;
    }
    const defaultEnablePlanMode = asBoolean(routingRaw.defaultEnablePlanMode);
    if (defaultEnablePlanMode !== null) {
      base.routing.defaultEnablePlanMode = defaultEnablePlanMode;
    }
    const directPatterns = asStringArray(routingRaw.directIntentPatterns);
    if (directPatterns) {
      base.routing.directIntentPatterns = directPatterns;
    }
  }

  const policyRaw = asObject(input.policy);
  if (policyRaw) {
    const defaultDecision = asPolicyDecision(policyRaw.default);
    if (defaultDecision) {
      base.policy.default = defaultDecision;
    }

    const toolsRaw = asObject(policyRaw.tools);
    if (toolsRaw) {
      const nextTools: Record<string, PolicyDecision> = {};
      for (const [toolName, decision] of Object.entries(toolsRaw)) {
        const parsedDecision = asPolicyDecision(decision);
        if (parsedDecision) {
          nextTools[toolName] = parsedDecision;
        }
      }
      base.policy.tools = {
        ...base.policy.tools,
        ...nextTools
      };
    }

    const commandRulesRaw = asObject(policyRaw.commandRules);
    if (commandRulesRaw) {
      const deny = asStringArray(commandRulesRaw.deny);
      const allow = asStringArray(commandRulesRaw.allow);
      if (deny) {
        base.policy.commandRules.deny = deny;
      }
      if (allow) {
        base.policy.commandRules.allow = allow;
      }
    }
  }

  const webSearchRaw = asObject(input.webSearch);
  if (webSearchRaw) {
    const enabled = asBoolean(webSearchRaw.enabled);
    if (enabled !== null) {
      base.webSearch.enabled = enabled;
    }
    const provider = asWebSearchProvider(webSearchRaw.provider);
    if (provider) {
      base.webSearch.provider = provider;
    }
    const maxUsesPerTask = asPositiveInt(webSearchRaw.maxUsesPerTask);
    if (maxUsesPerTask !== null) {
      base.webSearch.maxUsesPerTask = clamp(maxUsesPerTask, 1, 20);
    }
    const maxResultsPerUse = asPositiveInt(webSearchRaw.maxResultsPerUse);
    if (maxResultsPerUse !== null) {
      base.webSearch.maxResultsPerUse = clamp(maxResultsPerUse, 1, 10);
    }
    const maxCharsPerPage = asPositiveInt(webSearchRaw.maxCharsPerPage);
    if (maxCharsPerPage !== null) {
      base.webSearch.maxCharsPerPage = clamp(maxCharsPerPage, 1000, 200000);
    }
    const cacheTtlMs = asPositiveInt(webSearchRaw.cacheTtlMs);
    if (cacheTtlMs !== null) {
      base.webSearch.cacheTtlMs = clamp(cacheTtlMs, 1000, 24 * 60 * 60 * 1000);
    }
  }

  const toolLoopRaw = asObject(input.toolLoop);
  if (toolLoopRaw) {
    const searchMaxTurns = asPositiveInt(toolLoopRaw.searchMaxTurns);
    if (searchMaxTurns !== null) {
      base.toolLoop.searchMaxTurns = clamp(searchMaxTurns, 2, 50);
    }
    const coderMaxTurns = asPositiveInt(toolLoopRaw.coderMaxTurns);
    if (coderMaxTurns !== null) {
      base.toolLoop.coderMaxTurns = clamp(coderMaxTurns, 2, 100);
    }
    const noProgressRepeatTurns = asPositiveInt(toolLoopRaw.noProgressRepeatTurns);
    if (noProgressRepeatTurns !== null) {
      base.toolLoop.noProgressRepeatTurns = clamp(noProgressRepeatTurns, 1, 10);
    }
  }

  const mcpRaw = asObject(input.mcp);
  if (mcpRaw) {
    const enabled = asBoolean(mcpRaw.enabled);
    if (enabled !== null) {
      base.mcp.enabled = enabled;
    }

    const command = asString(mcpRaw.command);
    if (command !== null) {
      base.mcp.command = command;
    }

    const args = asStringArray(mcpRaw.args);
    if (args) {
      base.mcp.args = args;
    }

    const env = asRecordOfStrings(mcpRaw.env);
    if (env) {
      base.mcp.env = env;
    }

    const tools = asObject(mcpRaw.tools);
    if (tools) {
      const webSearch = asString(tools.webSearch);
      if (webSearch) {
        base.mcp.tools.webSearch = webSearch;
      }
      const fetchUrl = asString(tools.fetchUrl);
      if (fetchUrl) {
        base.mcp.tools.fetchUrl = fetchUrl;
      }
    }

    const startupTimeoutMs = asPositiveInt(mcpRaw.startupTimeoutMs);
    if (startupTimeoutMs !== null) {
      base.mcp.startupTimeoutMs = clamp(startupTimeoutMs, 1000, 120000);
    }

    const requestTimeoutMs = asPositiveInt(mcpRaw.requestTimeoutMs);
    if (requestTimeoutMs !== null) {
      base.mcp.requestTimeoutMs = clamp(requestTimeoutMs, 1000, 300000);
    }
  }

  return base;
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter((item) => item.length > 0);
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.trim();
}

function asRecordOfStrings(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") {
      output[key] = raw;
    }
  }
  return output;
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(1, Math.floor(value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function asPolicyDecision(value: unknown): PolicyDecision | null {
  if (value === "allow" || value === "ask" || value === "deny") {
    return value;
  }
  return null;
}

function asWebSearchProvider(value: unknown): "mcp" | "http" | null {
  if (value === "mcp" || value === "http") {
    return value;
  }
  return null;
}
function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

