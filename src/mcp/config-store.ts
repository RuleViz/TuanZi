import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentHomePath } from "../core/agent-store";

export interface McpServerConfigEntry {
  enabled?: boolean;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfigEntry>;
}

const MCP_CONFIG_FILE_NAME = "mcp_config.json";

export function getMcpConfigPath(): string {
  // Prefer new env var, fallback to legacy name.
  const fromEnv =
    (typeof process.env.TUANZI_MCP_CONFIG === "string" ? process.env.TUANZI_MCP_CONFIG.trim() : "") ||
    (typeof process.env.MYCODER_MCP_CONFIG === "string" ? process.env.MYCODER_MCP_CONFIG.trim() : "");
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.join(getAgentHomePath(), MCP_CONFIG_FILE_NAME);
}

export function loadMcpConfigSync(): McpConfigFile {
  const filePath = getMcpConfigPath();
  if (!existsSync(filePath)) {
    return { mcpServers: {} };
  }

  try {
    const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
    if (!raw) {
      return { mcpServers: {} };
    }
    return normalizeMcpConfig(JSON.parse(raw) as unknown);
  } catch {
    return { mcpServers: {} };
  }
}

export function saveMcpConfigSync(input: unknown): McpConfigFile {
  const normalized = normalizeMcpConfig(input);
  const filePath = getMcpConfigPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export function normalizeMcpConfig(input: unknown): McpConfigFile {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { mcpServers: {} };
  }
  const record = input as Record<string, unknown>;
  const rawServers = record.mcpServers;
  if (!rawServers || typeof rawServers !== "object" || Array.isArray(rawServers)) {
    return { mcpServers: {} };
  }

  const normalizedServers: Record<string, McpServerConfigEntry> = {};
  for (const [serverIdRaw, serverValue] of Object.entries(rawServers as Record<string, unknown>)) {
    const serverId = normalizeServerId(serverIdRaw);
    if (!serverId) {
      continue;
    }
    if (!serverValue || typeof serverValue !== "object" || Array.isArray(serverValue)) {
      continue;
    }
    const serverRecord = serverValue as Record<string, unknown>;
    const command = asString(serverRecord.command);
    if (!command) {
      continue;
    }
    const args = asStringArray(serverRecord.args);
    const env = asStringMap(serverRecord.env);
    const enabled = asBoolean(serverRecord.enabled);
    normalizedServers[serverId] = {
      ...(enabled === null ? {} : { enabled }),
      command,
      args,
      ...(env ? { env } : {})
    };
  }

  return { mcpServers: normalizedServers };
}

function normalizeServerId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function asStringMap(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") {
      output[key] = raw;
    }
  }
  return Object.keys(output).length > 0 ? output : null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value !== "boolean") {
    return null;
  }
  return value;
}
