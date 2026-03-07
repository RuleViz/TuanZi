import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadRuntimeConfig } from "./config";
import type { ApprovalMode } from "./core/approval-gate";
import {
  deleteStoredAgentSync,
  getStoredAgentSync,
  listStoredAgentsSync,
  loadAgentBackendConfigSync,
  saveAgentBackendConfigSync,
  saveStoredAgentSync
} from "./core/agent-store";
import type { JsonObject } from "./core/types";
import { loadMcpConfigSync, saveMcpConfigSync } from "./mcp/config-store";
import { McpManager } from "./mcp/manager";
import { createOrchestrator, createToolRuntime } from "./runtime";
import { getGreetingResponse } from "./greeting";
import { startInteractiveChat } from "./tui/interactive-chat";

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const [mainCommand, subCommand, ...restPositionals] = parsed.positionals;
  const helpFlag = parsed.flags.help === true;

  if (helpFlag || mainCommand === "help" || mainCommand === "--help" || mainCommand === "-h") {
    printHelp();
    return 0;
  }

  if (!mainCommand) {
    if (!input.isTTY || !output.isTTY) {
      printHelp();
      return 0;
    }
    return handleInteractiveChat(parsed.flags);
  }

  if (mainCommand === "chat" || (mainCommand === "agent" && subCommand === "chat")) {
    return handleInteractiveChat(parsed.flags);
  }

  if (mainCommand === "tools" && subCommand === "list") {
    return handleToolsList(parsed.flags);
  }
  if (mainCommand === "tools" && subCommand === "run") {
    return handleToolsRun(restPositionals, parsed.flags);
  }
  if (mainCommand === "agent" && subCommand === "run") {
    return handleAgentRun(parsed.flags);
  }

  if (mainCommand === "agents" && subCommand === "list") {
    return handleAgentsList();
  }
  if (mainCommand === "agents" && subCommand === "get") {
    return handleAgentsGet(restPositionals, parsed.flags);
  }
  if (mainCommand === "agents" && subCommand === "save") {
    return handleAgentsSave(parsed.flags);
  }
  if (mainCommand === "agents" && subCommand === "delete") {
    return handleAgentsDelete(restPositionals, parsed.flags);
  }

  if (mainCommand === "agent-config" && subCommand === "get") {
    return handleAgentConfigGet();
  }
  if (mainCommand === "agent-config" && subCommand === "save") {
    return handleAgentConfigSave(parsed.flags);
  }
  if (mainCommand === "mcp" && subCommand === "config" && restPositionals[0] === "get") {
    return handleMcpConfigGet();
  }
  if (mainCommand === "mcp" && subCommand === "config" && restPositionals[0] === "save") {
    return handleMcpConfigSave(parsed.flags);
  }
  if (mainCommand === "mcp" && subCommand === "tools" && restPositionals[0] === "list") {
    return handleMcpToolsList(parsed.flags);
  }
  if (mainCommand === "mcp" && subCommand === "tools" && restPositionals[0] === "call") {
    return handleMcpToolsCall(restPositionals.slice(1), parsed.flags);
  }

  if (mainCommand === "greet" || mainCommand === "hello") {
    return handleGreet(parsed.flags);
  }

  console.error(`Unknown command: ${argv.join(" ")}`);
  printHelp();
  return 1;
}

async function handleToolsList(flags: Record<string, string | boolean>): Promise<number> {
  const workspaceRoot = resolveWorkspace(flags.workspace as string | undefined);
  const runtimeConfig = loadRuntimeConfig({
    workspaceRoot,
    approvalMode: parseApprovalMode(flags.approval),
    agentOverride: parseOptionalFlag(flags.agent)
  });
  const runtime = createToolRuntime(runtimeConfig);
  const toolNames = runtime.registry.getToolNames();
  const payload = toolNames.map((name) => runtime.registry.getTool(name)!.definition);
  console.log(JSON.stringify(payload, null, 2));
  return 0;
}

async function handleInteractiveChat(flags: Record<string, string | boolean>): Promise<number> {
  const workspaceRoot = resolveWorkspace(flags.workspace as string | undefined);
  const approvalMode = parseApprovalMode(flags.approval);
  const modelOverride = parseOptionalFlag(flags.model);
  const agentOverride = parseOptionalFlag(flags.agent);

  return startInteractiveChat({
    workspaceRoot,
    approvalMode,
    modelOverride,
    agentOverride
  });
}

async function handleToolsRun(positionals: string[], flags: Record<string, string | boolean>): Promise<number> {
  const toolName = positionals[0] || (typeof flags.name === "string" ? flags.name : "");
  if (!toolName) {
    console.error("tools run requires tool name. Example: tools run view_file --args '{\"path\":\"...\"}'");
    return 1;
  }

  const workspaceRoot = resolveWorkspace(flags.workspace as string | undefined);
  const runtimeConfig = loadRuntimeConfig({
    workspaceRoot,
    approvalMode: parseApprovalMode(flags.approval),
    agentOverride: parseOptionalFlag(flags.agent)
  });
  const runtime = createToolRuntime(runtimeConfig);

  let argsRaw = "{}";
  if (typeof flags["args-file"] === "string") {
    argsRaw = await fs.readFile(path.resolve(flags["args-file"]), "utf8");
  } else if (typeof flags.args === "string") {
    argsRaw = flags.args;
  }
  argsRaw = argsRaw.replace(/^\uFEFF/, "").trim();

  let args: JsonObject;
  try {
    const parsed = JSON.parse(argsRaw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error("--args must be a JSON object.");
      return 1;
    }
    args = parsed as JsonObject;
  } catch (error) {
    console.error(`Invalid --args JSON: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const result = await runtime.registry.execute(toolName, args, runtime.toolContext);
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 2;
}

async function handleAgentRun(flags: Record<string, string | boolean>): Promise<number> {
  const workspaceRoot = resolveWorkspace(flags.workspace as string | undefined);
  const approvalMode = parseApprovalMode(flags.approval);
  const runtimeConfig = loadRuntimeConfig({
    workspaceRoot,
    approvalMode,
    modelOverride: parseOptionalFlag(flags.model),
    agentOverride: parseOptionalFlag(flags.agent)
  });
  const runtime = createToolRuntime(runtimeConfig);
  printModelRuntime(runtimeConfig);
  printAgentRuntime(runtimeConfig);

  let task = typeof flags.task === "string" ? flags.task.trim() : "";
  if (!task) {
    task = await promptTask();
  }
  if (!task) {
    console.error("Task cannot be empty.");
    return 1;
  }

  const orchestrator = createOrchestrator(runtimeConfig, runtime);
  runtime.logger.info("Running TuanZi loop ...");
  const result = await orchestrator.run({
    task
  });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

async function handleAgentsList(): Promise<number> {
  const agents = listStoredAgentsSync();
  const payload = agents.map((agent) => ({
    id: agent.id,
    filename: agent.filename,
    name: agent.name,
    avatar: agent.avatar,
    description: agent.description,
    tags: agent.tags,
    tools: agent.tools
  }));
  console.log(JSON.stringify(payload, null, 2));
  return 0;
}

async function handleAgentsGet(positionals: string[], flags: Record<string, string | boolean>): Promise<number> {
  const target =
    positionals[0] ||
    (typeof flags.id === "string" ? flags.id : "") ||
    (typeof flags.filename === "string" ? flags.filename : "") ||
    "default";
  try {
    const agent = getStoredAgentSync(target);
    console.log(JSON.stringify(agent, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function handleAgentsSave(flags: Record<string, string | boolean>): Promise<number> {
  let payload: unknown | null;
  try {
    payload = await readJsonPayloadFromFlags(flags);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    console.error("agents save requires a JSON object payload.");
    return 1;
  }

  const record = payload as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : "";
  const prompt = typeof record.prompt === "string" ? record.prompt : "";
  if (!name.trim()) {
    console.error("agents save requires non-empty field: name");
    return 1;
  }
  if (!prompt.trim()) {
    console.error("agents save requires non-empty field: prompt");
    return 1;
  }

  try {
    const saved = saveStoredAgentSync({
      filename: typeof record.filename === "string" ? record.filename : null,
      name,
      avatar: typeof record.avatar === "string" ? record.avatar : null,
      description: typeof record.description === "string" ? record.description : null,
      tags: asStringArray(record.tags),
      tools: asStringArray(record.tools),
      prompt
    });
    console.log(JSON.stringify(saved, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function handleAgentsDelete(positionals: string[], flags: Record<string, string | boolean>): Promise<number> {
  const target =
    positionals[0] ||
    (typeof flags.id === "string" ? flags.id : "") ||
    (typeof flags.filename === "string" ? flags.filename : "");
  if (!target.trim()) {
    console.error("agents delete requires an id or filename.");
    return 1;
  }

  try {
    deleteStoredAgentSync(target);
    console.log(JSON.stringify({ ok: true, deleted: target }, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function handleAgentConfigGet(): Promise<number> {
  const config = loadAgentBackendConfigSync();
  console.log(JSON.stringify(config, null, 2));
  return 0;
}

async function handleAgentConfigSave(flags: Record<string, string | boolean>): Promise<number> {
  let payload: unknown | null;
  try {
    payload = await readJsonPayloadFromFlags(flags);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (payload === null) {
    console.error("agent-config save requires --args or --args-file JSON payload.");
    return 1;
  }
  try {
    const saved = saveAgentBackendConfigSync(payload);
    console.log(JSON.stringify(saved, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function handleMcpConfigGet(): Promise<number> {
  const config = loadMcpConfigSync();
  console.log(JSON.stringify(config, null, 2));
  return 0;
}

async function handleMcpConfigSave(flags: Record<string, string | boolean>): Promise<number> {
  let payload: unknown | null;
  try {
    payload = await readJsonPayloadFromFlags(flags);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (payload === null) {
    console.error("mcp config save requires --args or --args-file JSON payload.");
    return 1;
  }

  try {
    const saved = saveMcpConfigSync(payload);
    console.log(JSON.stringify(saved, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function handleMcpToolsList(flags: Record<string, string | boolean>): Promise<number> {
  const workspaceRoot = resolveWorkspace(flags.workspace as string | undefined);
  const runtimeConfig = loadRuntimeConfig({
    workspaceRoot,
    approvalMode: parseApprovalMode(flags.approval),
    agentOverride: parseOptionalFlag(flags.agent)
  });
  const runtime = createToolRuntime(runtimeConfig);
  const manager = new McpManager(runtimeConfig.agentSettings.mcp, runtime.logger);
  try {
    const tools = await manager.listNamespacedTools();
    const payload = tools.map((item) => ({
      name: item.namespacedName,
      description: item.description,
      inputSchema: item.inputSchema
    }));
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  } finally {
    await manager.stopAll();
  }
}

async function handleMcpToolsCall(positionals: string[], flags: Record<string, string | boolean>): Promise<number> {
  const namespacedName = positionals[0] || (typeof flags.name === "string" ? flags.name : "");
  if (!namespacedName) {
    console.error(
      "mcp tools call requires namespaced tool name. Example: mcp tools call mcp__sequentialthinking__sequentialthinking --args '{\"thought\":\"...\"}'"
    );
    return 1;
  }

  let payload: unknown | null;
  try {
    payload = await readJsonPayloadFromFlags(flags);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const args =
    payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as JsonObject) : ({} as JsonObject);

  const workspaceRoot = resolveWorkspace(flags.workspace as string | undefined);
  const runtimeConfig = loadRuntimeConfig({
    workspaceRoot,
    approvalMode: parseApprovalMode(flags.approval),
    agentOverride: parseOptionalFlag(flags.agent)
  });
  const runtime = createToolRuntime(runtimeConfig);
  const manager = new McpManager(runtimeConfig.agentSettings.mcp, runtime.logger);
  try {
    const result = await manager.callNamespacedTool(namespacedName, args);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await manager.stopAll();
  }
}

async function readJsonPayloadFromFlags(flags: Record<string, string | boolean>): Promise<unknown | null> {
  let argsRaw = "";
  if (typeof flags["args-file"] === "string") {
    argsRaw = await fs.readFile(path.resolve(flags["args-file"]), "utf8");
  } else if (typeof flags.args === "string") {
    argsRaw = flags.args;
  }
  argsRaw = argsRaw.replace(/^\uFEFF/, "").trim();
  if (!argsRaw) {
    return null;
  }

  try {
    return JSON.parse(argsRaw) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string | boolean> } {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  return { positionals, flags };
}

function parseApprovalMode(inputMode: string | boolean | undefined): ApprovalMode {
  if (typeof inputMode !== "string") {
    return "manual";
  }
  if (inputMode === "auto" || inputMode === "manual" || inputMode === "deny") {
    return inputMode;
  }
  return "manual";
}

function resolveWorkspace(rawWorkspace: string | undefined): string {
  return path.resolve(rawWorkspace ?? process.cwd());
}

function parseOptionalFlag(value: string | boolean | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

async function promptTask(): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    return "";
  }
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question("请输入任务描述: ")).trim();
  } finally {
    rl.close();
  }
}

function printHelp(): void {
  console.log(
    [
      "TuanZi (团子) CLI",
      "",
      "Commands:",
      "  chat [--workspace <abs-path>] [--approval manual|auto|deny] [--model <name>] [--agent <id|filename>]",
      "  (no command)                           等同于 chat，默认进入交互模式",
      "  greet [--time-based]                   显示中文问候语",
      "  hello [--time-based]                   显示中文问候语",
      "  agent run --task \"<task>\" [--workspace <abs-path>] [--approval manual|auto|deny] [--model <name>] [--agent <id|filename>]",
      "  agent chat [--workspace <abs-path>] [--approval manual|auto|deny] [--model <name>] [--agent <id|filename>]",
      "  tools list [--workspace <abs-path>] [--agent <id|filename>]",
      "  tools run <toolName> --args '{\"key\":\"value\"}' [--workspace <abs-path>] [--approval manual|auto|deny] [--agent <id|filename>]",
      "  tools run <toolName> --args-file <json-file> [--workspace <abs-path>] [--approval manual|auto|deny] [--agent <id|filename>]",
      "  agents list",
      "  agents get <id|filename>",
      "  agents save --args '{\"name\":\"...\",\"prompt\":\"...\",\"tools\":[\"view_file\"]}'",
      "  agents delete <id|filename>",
      "  agent-config get",
      "  agent-config save --args '{\"global_skills\":{...},\"provider\":{...}}'",
      "  mcp config get",
      "  mcp config save --args '{\"mcpServers\":{\"serverId\":{\"command\":\"npx\",\"args\":[\"-y\",\"@modelcontextprotocol/server-filesystem\",\"E:/project\"]}}}'",
      "  mcp tools list",
      "  mcp tools call <mcp__serverId__toolName> --args '{\"key\":\"value\"}'",
      "",
      "Model config:",
      "  Use chat /model commands to manage models",
      "  Legacy store path: ~/.tuanzi/models.json",
      "  New provider path: ~/.mycoderagent/config.json -> provider",
      "",
      "Project config file:",
      "  agent.config.json      routing/policy/webSearch/toolLoop/mcp settings"
    ].join("\n")
  );
}

function printModelRuntime(runtimeConfig: ReturnType<typeof loadRuntimeConfig>): void {
  const model = runtimeConfig.model;
  const planner = model.plannerModel ?? "<unset>";
  const search = model.searchModel ?? "<unset>";
  const coder = model.coderModel ?? "<unset>";
  const hasKey = model.apiKey ? "yes" : "no";
  console.log(
    `[model] keySource=${model.keySource} apiKey=${hasKey} baseUrl=${model.baseUrl} planner=${planner} search=${search} coder=${coder}`
  );
}

function printAgentRuntime(runtimeConfig: ReturnType<typeof loadRuntimeConfig>): void {
  const active = runtimeConfig.agentBackend.activeAgent;
  console.log(
    `[agent] active=${active.filename} name=${active.name} tools=${active.tools.length} globalSkills=${JSON.stringify(
      runtimeConfig.agentBackend.config.global_skills
    )}`
  );
}

async function handleGreet(flags: Record<string, string | boolean>): Promise<number> {
  const timeBased = flags["time-based"] === true;
  const greeting = getGreetingResponse(timeBased);
  console.log(greeting);
  return 0;
}

