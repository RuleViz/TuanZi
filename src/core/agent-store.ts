import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type GlobalSkillCategory = "file_system" | "execute_command" | "web_search";

export interface AgentProviderConfig {
  type: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface GlobalSkillsConfig {
  file_system: boolean;
  execute_command: boolean;
  web_search: boolean;
}

export interface AgentBackendConfig {
  provider: AgentProviderConfig;
  global_skills: GlobalSkillsConfig;
}

export interface AgentMetadata {
  name: string;
  avatar: string;
  description: string;
  tags: string[];
  tools: string[];
}

export interface StoredAgent extends AgentMetadata {
  id: string;
  filename: string;
  prompt: string;
}

export interface SaveStoredAgentInput {
  filename?: string | null;
  name: string;
  avatar?: string | null;
  description?: string | null;
  tags?: string[];
  tools?: string[];
  prompt: string;
}

const AGENT_HOME_DIR_NAME = ".mycoderagent";
const AGENT_CONFIG_FILE_NAME = "config.json";
const AGENTS_DIR_NAME = "agents";
const DEFAULT_AGENT_FILE_NAME = "default.md";

const DEFAULT_BACKEND_CONFIG: AgentBackendConfig = {
  provider: {
    type: "openai",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    model: ""
  },
  global_skills: {
    file_system: true,
    execute_command: true,
    web_search: true
  }
};

const DEFAULT_AGENT_METADATA: AgentMetadata = {
  name: "默认助手",
  avatar: "🍡",
  description: "系统默认 Agent，支持通用开发与自动化任务。",
  tags: ["default", "general"],
  tools: [
    "list_dir",
    "find_by_name",
    "grep_search",
    "view_file",
    "write_to_file",
    "diff_apply",
    "delete_file",
    "codebase_search",
    "run_command",
    "browser_action",
    "checkpoint"
  ]
};

const DEFAULT_AGENT_PROMPT = [
  "你是 TuanZi（团子），一个务实可靠的通用 AI 助手。",
  "你需要先理解用户意图，再按需读取上下文、执行工具并验证结果。",
  "任何工具失败都必须如实说明，禁止伪造成功日志或结果。"
].join("\n");

export function getAgentHomePath(): string {
  const override = normalizeOptionalString(process.env.MYCODERAGENT_HOME);
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), AGENT_HOME_DIR_NAME);
}

export function getAgentConfigPath(): string {
  return path.join(getAgentHomePath(), AGENT_CONFIG_FILE_NAME);
}

export function getAgentsDirectoryPath(): string {
  return path.join(getAgentHomePath(), AGENTS_DIR_NAME);
}

export function getDefaultAgentFileName(): string {
  return DEFAULT_AGENT_FILE_NAME;
}

export function ensureAgentStoreSync(): void {
  const homePath = getAgentHomePath();
  const agentsPath = getAgentsDirectoryPath();
  mkdirSync(homePath, { recursive: true });
  mkdirSync(agentsPath, { recursive: true });

  const configPath = getAgentConfigPath();
  if (!existsSync(configPath)) {
    writeJsonFile(configPath, DEFAULT_BACKEND_CONFIG);
  }

  const defaultAgentPath = path.join(agentsPath, DEFAULT_AGENT_FILE_NAME);
  if (!existsSync(defaultAgentPath)) {
    writeFileSync(defaultAgentPath, serializeAgentMarkdown(DEFAULT_AGENT_METADATA, DEFAULT_AGENT_PROMPT), "utf8");
  }
}

export function loadAgentBackendConfigSync(): AgentBackendConfig {
  ensureAgentStoreSync();
  const filePath = getAgentConfigPath();

  try {
    const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
    if (!raw) {
      return cloneDefaultBackendConfig();
    }
    const parsed = JSON.parse(raw) as unknown;
    return normalizeBackendConfig(parsed);
  } catch (error) {
    console.warn(
      `[WARN] Failed to parse ${AGENT_CONFIG_FILE_NAME}, fallback to defaults: ${error instanceof Error ? error.message : String(error)
      }`
    );
    return cloneDefaultBackendConfig();
  }
}

export function saveAgentBackendConfigSync(input: unknown): AgentBackendConfig {
  ensureAgentStoreSync();
  const normalized = normalizeBackendConfig(input);
  writeJsonFile(getAgentConfigPath(), normalized);
  return normalized;
}

export function listStoredAgentsSync(): StoredAgent[] {
  ensureAgentStoreSync();
  const agentsPath = getAgentsDirectoryPath();
  const entries = readdirSync(agentsPath, { withFileTypes: true });
  const output: StoredAgent[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }
    const filePath = path.join(agentsPath, entry.name);
    try {
      const raw = readFileSync(filePath, "utf8");
      output.push(parseAgentMarkdown(raw, entry.name));
    } catch (error) {
      console.warn(
        `[WARN] Failed to read agent file ${entry.name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  output.sort((left, right) => {
    if (left.filename === DEFAULT_AGENT_FILE_NAME && right.filename !== DEFAULT_AGENT_FILE_NAME) {
      return -1;
    }
    if (right.filename === DEFAULT_AGENT_FILE_NAME && left.filename !== DEFAULT_AGENT_FILE_NAME) {
      return 1;
    }
    return left.filename.localeCompare(right.filename);
  });

  return output;
}

export function getStoredAgentSync(identifier: string | null | undefined): StoredAgent {
  ensureAgentStoreSync();
  const filename = resolveAgentFileName(identifier ?? DEFAULT_AGENT_FILE_NAME);
  const filePath = path.join(getAgentsDirectoryPath(), filename);

  if (!existsSync(filePath)) {
    throw new Error(`Agent not found: ${filename}`);
  }

  const raw = readFileSync(filePath, "utf8");
  return parseAgentMarkdown(raw, filename);
}

export function loadActiveAgentSync(agentOverride?: string | null): StoredAgent {
  ensureAgentStoreSync();
  const preferred = normalizeOptionalString(agentOverride);
  if (preferred) {
    try {
      return getStoredAgentSync(preferred);
    } catch (error) {
      console.warn(
        `[WARN] agent override not found (${preferred}), fallback to default: ${error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  try {
    return getStoredAgentSync(DEFAULT_AGENT_FILE_NAME);
  } catch {
    const listed = listStoredAgentsSync();
    if (listed.length > 0) {
      return listed[0];
    }
  }

  return saveStoredAgentSync({
    filename: DEFAULT_AGENT_FILE_NAME,
    name: DEFAULT_AGENT_METADATA.name,
    avatar: DEFAULT_AGENT_METADATA.avatar,
    description: DEFAULT_AGENT_METADATA.description,
    tags: DEFAULT_AGENT_METADATA.tags,
    tools: DEFAULT_AGENT_METADATA.tools,
    prompt: DEFAULT_AGENT_PROMPT
  });
}

export function saveStoredAgentSync(input: SaveStoredAgentInput): StoredAgent {
  ensureAgentStoreSync();
  const normalized = normalizeAgentInput(input);
  const filename = resolveAgentFileName(input.filename ?? normalized.name);
  const filePath = path.join(getAgentsDirectoryPath(), filename);
  writeFileSync(filePath, serializeAgentMarkdown(normalized, normalized.prompt), "utf8");
  return parseAgentMarkdown(readFileSync(filePath, "utf8"), filename);
}

export function deleteStoredAgentSync(identifier: string): void {
  ensureAgentStoreSync();
  const filename = resolveAgentFileName(identifier);
  if (filename.toLowerCase() === DEFAULT_AGENT_FILE_NAME.toLowerCase()) {
    throw new Error(`${DEFAULT_AGENT_FILE_NAME} cannot be deleted.`);
  }
  const filePath = path.join(getAgentsDirectoryPath(), filename);
  if (!existsSync(filePath)) {
    throw new Error(`Agent not found: ${filename}`);
  }
  unlinkSync(filePath);
}

function normalizeBackendConfig(input: unknown): AgentBackendConfig {
  const raw = asRecord(input);
  if (!raw) {
    return cloneDefaultBackendConfig();
  }

  const providerRaw = asRecord(raw.provider) ?? {};
  const skillsRaw = asRecord(raw.global_skills) ?? {};

  const provider: AgentProviderConfig = {
    type: normalizeOptionalString(providerRaw.type) ?? DEFAULT_BACKEND_CONFIG.provider.type,
    apiKey: normalizeOptionalString(providerRaw.apiKey) ?? "",
    baseUrl: normalizeOptionalString(providerRaw.baseUrl) ?? DEFAULT_BACKEND_CONFIG.provider.baseUrl,
    model: normalizeOptionalString(providerRaw.model) ?? ""
  };

  const global_skills: GlobalSkillsConfig = {
    file_system:
      typeof skillsRaw.file_system === "boolean"
        ? skillsRaw.file_system
        : DEFAULT_BACKEND_CONFIG.global_skills.file_system,
    execute_command:
      typeof skillsRaw.execute_command === "boolean"
        ? skillsRaw.execute_command
        : DEFAULT_BACKEND_CONFIG.global_skills.execute_command,
    web_search:
      typeof skillsRaw.web_search === "boolean" ? skillsRaw.web_search : DEFAULT_BACKEND_CONFIG.global_skills.web_search
  };

  return {
    provider,
    global_skills
  };
}

function cloneDefaultBackendConfig(): AgentBackendConfig {
  return JSON.parse(JSON.stringify(DEFAULT_BACKEND_CONFIG)) as AgentBackendConfig;
}

function normalizeAgentInput(input: SaveStoredAgentInput): AgentMetadata & { prompt: string } {
  const name = normalizeOptionalString(input.name) ?? "未命名 Agent";
  const avatar = normalizeOptionalString(input.avatar) ?? "";
  const description = normalizeOptionalString(input.description) ?? "";
  const tags = normalizeStringArray(input.tags);
  const tools = normalizeStringArray(input.tools);
  const prompt = normalizeOptionalString(input.prompt) ?? DEFAULT_AGENT_PROMPT;

  return {
    name,
    avatar,
    description,
    tags,
    tools,
    prompt
  };
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") {
      continue;
    }
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function resolveAgentFileName(input: string): string {
  const trimmed = normalizeOptionalString(input);
  if (!trimmed) {
    return DEFAULT_AGENT_FILE_NAME;
  }

  const baseName = path.basename(trimmed);
  if (baseName !== trimmed) {
    throw new Error("Agent identifier must not contain path separators.");
  }

  const stripped = baseName.toLowerCase().endsWith(".md") ? baseName.slice(0, -3) : baseName;
  const safe = stripped
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
  const normalized = safe.trim();
  if (!normalized) {
    throw new Error("Invalid agent identifier.");
  }
  return `${normalized}.md`;
}

function parseAgentMarkdown(rawContent: string, filename: string): StoredAgent {
  const { frontmatter, body } = splitFrontmatter(rawContent);
  const frontmatterData = parseFrontmatter(frontmatter);
  const id = filenameToId(filename);

  const name = parseFrontmatterString(frontmatterData.name) ?? id;
  const avatar = parseFrontmatterString(frontmatterData.avatar) ?? "";
  const description = parseFrontmatterString(frontmatterData.description) ?? "";
  const tags = parseFrontmatterArray(frontmatterData.tags);
  const tools = parseFrontmatterArray(frontmatterData.tools);
  const prompt = normalizeOptionalString(body) ?? DEFAULT_AGENT_PROMPT;

  return {
    id,
    filename,
    name,
    avatar,
    description,
    tags,
    tools,
    prompt
  };
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: "", body: normalized };
  }

  const lines = normalized.split("\n");
  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      endIndex = index;
      break;
    }
  }

  if (endIndex < 0) {
    return { frontmatter: "", body: normalized };
  }

  return {
    frontmatter: lines.slice(1, endIndex).join("\n"),
    body: lines.slice(endIndex + 1).join("\n")
  };
}

function parseFrontmatter(input: string): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  if (!input.trim()) {
    return output;
  }

  const lines = input.split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const current = lines[index].trim();
    if (!current || current.startsWith("#")) {
      index += 1;
      continue;
    }

    const match = current.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!match) {
      index += 1;
      continue;
    }

    const key = match[1];
    const inlineValue = match[2].trim();
    if (inlineValue) {
      output[key] = inlineValue.startsWith("[") && inlineValue.endsWith("]")
        ? parseInlineYamlArray(inlineValue)
        : parseYamlScalar(inlineValue);
      index += 1;
      continue;
    }

    index += 1;
    const listValues: string[] = [];
    while (index < lines.length) {
      const nextLine = lines[index];
      if (!nextLine.trim()) {
        index += 1;
        continue;
      }
      const itemMatch = nextLine.match(/^\s*-\s*(.+)\s*$/);
      if (!itemMatch) {
        break;
      }
      listValues.push(parseYamlScalar(itemMatch[1]));
      index += 1;
    }
    output[key] = listValues;
  }

  return output;
}

function parseInlineYamlArray(input: string): string[] {
  const core = input.trim().slice(1, -1).trim();
  if (!core) {
    return [];
  }

  const values: string[] = [];
  let buffer = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const ch of core) {
    if (escaped) {
      buffer += ch;
      escaped = false;
      continue;
    }

    if (quote === '"') {
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        quote = null;
        continue;
      }
      buffer += ch;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
        continue;
      }
      buffer += ch;
      continue;
    }

    if (ch === '"') {
      quote = '"';
      continue;
    }
    if (ch === "'") {
      quote = "'";
      continue;
    }
    if (ch === ",") {
      values.push(parseYamlScalar(buffer));
      buffer = "";
      continue;
    }
    buffer += ch;
  }

  values.push(parseYamlScalar(buffer));
  return values.map((item) => item.trim()).filter((item) => item.length > 0);
}

function parseYamlScalar(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function parseFrontmatterString(input: string | string[] | undefined): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const normalized = input.trim();
  return normalized.length > 0 ? normalized : null;
}

function parseFrontmatterArray(input: string | string[] | undefined): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return normalizeStringArray(input);
}

function serializeAgentMarkdown(metadata: AgentMetadata, prompt: string): string {
  const lines = [
    "---",
    `name: ${toYamlQuoted(metadata.name)}`,
    `avatar: ${toYamlQuoted(metadata.avatar)}`,
    `description: ${toYamlQuoted(metadata.description)}`,
    "tags:",
    ...metadata.tags.map((item) => `  - ${toYamlQuoted(item)}`),
    "tools:",
    ...metadata.tools.map((item) => `  - ${toYamlQuoted(item)}`),
    "---",
    "",
    prompt.trim(),
    ""
  ];
  return lines.join("\n");
}

function toYamlQuoted(input: string): string {
  return `"${input.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function filenameToId(filename: string): string {
  return filename.toLowerCase().endsWith(".md") ? filename.slice(0, -3) : filename;
}

function writeJsonFile(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

function normalizeOptionalString(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const trimmed = input.trim();
  return trimmed ? trimmed : null;
}
