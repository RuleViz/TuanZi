import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ToolLoopResumeState, ToolLoopToolCallSnapshot } from "./agents/react-tool-agent";
import { loadRuntimeConfig } from "./config";
import type { ApprovalMode } from "./core/approval-gate";
import { AgentRunStore } from "./core/agent-run-store";
import {
  deleteStoredAgentSync,
  getStoredAgentSync,
  listStoredAgentsSync,
  loadAgentBackendConfigSync,
  saveAgentBackendConfigSync,
  saveStoredAgentSync
} from "./core/agent-store";
import type { JsonObject, ToolCallRecord, ToolExecutionResult } from "./core/types";
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

  if (mainCommand === "skills" && subCommand === "list") {
    return handleSkillsList(parsed.flags);
  }
  if (mainCommand === "skills" && subCommand === "get") {
    return handleSkillsGet(restPositionals, parsed.flags);
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
  const modelOverride = parseOptionalFlag(flags.model);
  const agentOverride = parseOptionalFlag(flags.agent);
  const runtimeConfig = loadRuntimeConfig({
    workspaceRoot,
    approvalMode,
    modelOverride,
    agentOverride
  });
  const runtime = createToolRuntime(runtimeConfig);
  const runStore = new AgentRunStore(workspaceRoot);
  printModelRuntime(runtimeConfig);
  printAgentRuntime(runtimeConfig);

  const resumeRequested = flags.resume === true || typeof flags.resume === "string";
  const activeSnapshot = resumeRequested ? await runStore.loadActiveRun() : null;
  let task = typeof flags.task === "string" ? flags.task.trim() : "";
  if (!task && activeSnapshot) {
    task = activeSnapshot.task;
  }
  if (!task && !resumeRequested) {
    task = await promptTask();
  }
  if (!task) {
    console.error(resumeRequested ? "No interrupted agent run snapshot found." : "Task cannot be empty.");
    return 1;
  }

  if (activeSnapshot) {
    printAgentRunSnapshotNotice(activeSnapshot);
    if (activeSnapshot.streamedResponse) {
      console.log("\nPartial assistant output:\n");
      output.write(activeSnapshot.streamedResponse);
      if (!activeSnapshot.streamedResponse.endsWith("\n")) {
        output.write("\n");
      }
      output.write("\n");
    }
    renderAgentRunToolCalls(activeSnapshot.toolCalls);
  }

  const orchestrator = createOrchestrator(runtimeConfig, runtime);
  const controller = new AbortController();
  let lastSigintAt = 0;
  let streamedResponse = activeSnapshot?.streamedResponse ?? "";
  let renderedToolCalls = 0;
  let latestResumeState = activeSnapshot?.resumeState ?? null;
  const createdAt = activeSnapshot?.createdAt ?? new Date().toISOString();
  let persistChain: Promise<void> = runStore.saveActiveRun({
    ...(activeSnapshot?.createdAt ? { createdAt: activeSnapshot.createdAt } : {}),
    status: "running",
    workspaceRoot,
    modelOverride,
    agentOverride,
    task,
    preparedTask: activeSnapshot?.preparedTask ?? task,
    streamedResponse,
    toolCalls: cloneToolCallRecords(activeSnapshot?.toolCalls ?? []),
    resumeState: activeSnapshot?.resumeState ?? null
  }).then((snapshot) => {
    latestResumeState = snapshot.resumeState;
  });

  const queueSnapshotPersist = (snapshot: {
    status: "running" | "interrupted";
    preparedTask: string;
    streamedResponse: string;
    toolCalls: ToolCallRecord[];
    resumeState: ToolLoopResumeState | null;
  }): void => {
    persistChain = persistChain
      .catch(() => undefined)
      .then(() =>
        runStore.saveActiveRun({
          createdAt,
          status: snapshot.status,
          workspaceRoot,
          modelOverride,
          agentOverride,
          task,
          preparedTask: snapshot.preparedTask,
          streamedResponse: snapshot.streamedResponse,
          toolCalls: cloneToolCallRecords(snapshot.toolCalls),
          resumeState: snapshot.resumeState ? cloneJson(snapshot.resumeState) : null
        })
      )
      .then((saved) => {
        latestResumeState = saved.resumeState;
      });
  };

  const onSigint = (): void => {
    const now = Date.now();
    const isDoublePress = now - lastSigintAt < 1500;
    lastSigintAt = now;
    if (!controller.signal.aborted) {
      controller.abort();
      console.error(
        isDoublePress
          ? "\nInterrupt received. Saving current agent run snapshot before exit."
          : "\nInterrupt received. Saving current agent run snapshot. Re-run with --resume to continue."
      );
      return;
    }
    console.error("\nStill waiting for the interrupted run to finish cleanup.");
  };

  process.on("SIGINT", onSigint);
  runtime.logger.info("Running TuanZi loop ...");
  try {
    const result = await orchestrator.run(
      {
        task: activeSnapshot?.preparedTask ?? task,
        resumeState: activeSnapshot?.resumeState ?? undefined
      },
      {
        onAssistantTextDelta: (delta) => {
          if (!delta) {
            return;
          }
          streamedResponse += delta;
          output.write(delta);
        },
        onToolCallCompleted: (call) => {
          const record = toToolCallRecord(call);
          renderAgentRunToolCall(record);
          renderedToolCalls += 1;
        },
        onStateChange: (state) => {
          latestResumeState = state;
          queueSnapshotPersist({
            status: controller.signal.aborted ? "interrupted" : "running",
            preparedTask: activeSnapshot?.preparedTask ?? task,
            streamedResponse,
            toolCalls: toToolCallRecords(state.toolCalls),
            resumeState: state
          });
        },
        signal: controller.signal
      }
    );
    await persistChain.catch(() => undefined);
    await runStore.clearActiveRun();
    if (streamedResponse && !streamedResponse.endsWith("\n")) {
      output.write("\n");
    }
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    await persistChain.catch(() => undefined);
    if (controller.signal.aborted || (error instanceof Error && error.message === "Interrupted by user")) {
      queueSnapshotPersist({
        status: "interrupted",
        preparedTask: activeSnapshot?.preparedTask ?? task,
        streamedResponse,
        toolCalls: toToolCallRecords(latestResumeState?.toolCalls ?? []),
        resumeState: latestResumeState
      });
      await persistChain.catch(() => undefined);
      return 130;
    }
    await runStore.clearActiveRun();
    throw error;
  } finally {
    process.off("SIGINT", onSigint);
  }
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

async function handleSkillsList(flags: Record<string, string | boolean>): Promise<number> {
  const workspaceRoot = resolveWorkspace(flags.workspace as string | undefined);
  const runtimeConfig = loadRuntimeConfig({
    workspaceRoot,
    approvalMode: parseApprovalMode(flags.approval),
    agentOverride: parseOptionalFlag(flags.agent)
  });
  const runtime = createToolRuntime(runtimeConfig);
  const payload = runtime.toolContext.skillRuntime?.listCatalog() ?? [];
  console.log(JSON.stringify(payload, null, 2));
  return 0;
}

async function handleSkillsGet(positionals: string[], flags: Record<string, string | boolean>): Promise<number> {
  const target = positionals[0] || (typeof flags.name === "string" ? flags.name : "");
  if (!target.trim()) {
    console.error("skills get requires a skill name.");
    return 1;
  }

  const workspaceRoot = resolveWorkspace(flags.workspace as string | undefined);
  const runtimeConfig = loadRuntimeConfig({
    workspaceRoot,
    approvalMode: parseApprovalMode(flags.approval),
    agentOverride: parseOptionalFlag(flags.agent)
  });
  const runtime = createToolRuntime(runtimeConfig);
  const skillRuntime = runtime.toolContext.skillRuntime;
  if (!skillRuntime) {
    console.error("skill runtime is not configured.");
    return 1;
  }

  try {
    const skill = skillRuntime.loadSkill(target);
    const catalogItem = skillRuntime
      .listCatalog()
      .find((item) => item.name.toLowerCase() === skill.frontmatter.name.toLowerCase());
    console.log(
      JSON.stringify(
        {
          ...skill,
          skillDir: catalogItem?.skillDir ?? null,
          skillFile: catalogItem?.skillFile ?? null
        },
        null,
        2
      )
    );
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

function printAgentRunSnapshotNotice(snapshot: {
  updatedAt: string;
  task: string;
  toolCalls: ToolCallRecord[];
}): void {
  console.log(`Detected interrupted agent run snapshot (${snapshot.updatedAt}).`);
  console.log(`  Task: ${truncateMiddle(snapshot.task.trim(), 120) || "[empty task]"}`);
  console.log(`  Completed tool calls: ${snapshot.toolCalls.length}`);
  console.log("  Use `agent run --resume` to continue.\n");
}

function renderAgentRunToolCalls(toolCalls: ToolCallRecord[]): void {
  if (toolCalls.length === 0) {
    return;
  }
  console.log("Recovered tool calls:");
  for (const call of toolCalls) {
    renderAgentRunToolCall(call);
  }
  console.log("");
}

function renderAgentRunToolCall(call: ToolCallRecord): void {
  const argsText = safeOneLineJson(call.args, 180);
  const status = call.result.ok ? "ok" : "failed";
  const summary = summarizeToolResult(call.result);
  console.log(`  - ${call.toolName} (${status})`);
  console.log(`    args: ${argsText}`);
  console.log(`    result: ${summary}`);
}

function summarizeToolResult(result: ToolExecutionResult): string {
  if (result.ok) {
    if (result.data === undefined) {
      return "ok";
    }
    return truncateMiddle(safeOneLineJson(result.data, 240), 240);
  }
  return truncateMiddle(result.error ?? "unknown error", 240);
}

function safeOneLineJson(value: unknown, maxChars: number): string {
  try {
    const text = JSON.stringify(value);
    if (!text) {
      return "{}";
    }
    return truncateMiddle(text, maxChars);
  } catch {
    return "[unserializable]";
  }
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 8) {
    return text.slice(0, maxChars);
  }
  const side = Math.floor((maxChars - 5) / 2);
  return `${text.slice(0, side)} ... ${text.slice(text.length - side)}`;
}

function toToolCallRecord(call: ToolLoopToolCallSnapshot): ToolCallRecord {
  return {
    toolName: call.name,
    args: cloneJson(call.args),
    result: cloneJson(call.result),
    timestamp: new Date().toISOString()
  };
}

function toToolCallRecords(calls: ToolLoopToolCallSnapshot[]): ToolCallRecord[] {
  return calls.map((call) => toToolCallRecord(call));
}

function cloneToolCallRecords(calls: ToolCallRecord[]): ToolCallRecord[] {
  return cloneJson(calls);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
      "  agent run --resume                    继续上次被中断的单次执行",
      "  agent chat [--workspace <abs-path>] [--approval manual|auto|deny] [--model <name>] [--agent <id|filename>]",
      "  tools list [--workspace <abs-path>] [--agent <id|filename>]",
      "  tools run <toolName> --args '{\"key\":\"value\"}' [--workspace <abs-path>] [--approval manual|auto|deny] [--agent <id|filename>]",
      "  tools run <toolName> --args-file <json-file> [--workspace <abs-path>] [--approval manual|auto|deny] [--agent <id|filename>]",
      "  agents list",
      "  agents get <id|filename>",
      "  agents save --args '{\"name\":\"...\",\"prompt\":\"...\",\"tools\":[\"view_file\"]}'",
      "  agents delete <id|filename>",
      "  skills list [--workspace <abs-path>]",
      "  skills get <skill-name> [--workspace <abs-path>]",
      "  agent-config get",
      "  agent-config save --args '{\"provider\":{...},\"providers\":[...],\"activeProviderId\":\"...\"}'",
      "  mcp config get",
      "  mcp config save --args '{\"mcpServers\":{\"serverId\":{\"command\":\"npx\",\"args\":[\"-y\",\"@modelcontextprotocol/server-filesystem\",\"E:/project\"]}}}'",
      "  mcp tools list",
      "  mcp tools call <mcp__serverId__toolName> --args '{\"key\":\"value\"}'",
      "",
      "Model config:",
      "  Use chat /model commands to manage models",
      "  Legacy store path: ~/.tuanzi/models.json",
      "  New provider path: ~/.tuanzi/config.json -> provider",
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
  console.log(`[agent] active=${active.filename} name=${active.name} tools=${active.tools.length}`);
}

async function handleGreet(flags: Record<string, string | boolean>): Promise<number> {
  const timeBased = flags["time-based"] === true;
  const greeting = getGreetingResponse(timeBased);
  console.log(greeting);
  return 0;
}

