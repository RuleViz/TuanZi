import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadRuntimeConfig } from "./config";
import type { ApprovalMode } from "./core/approval-gate";
import type { JsonObject } from "./core/types";
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
    approvalMode: parseApprovalMode(flags.approval)
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
  const modelOverride = typeof flags.model === "string" && flags.model.trim() ? flags.model.trim() : null;

  return startInteractiveChat({
    workspaceRoot,
    approvalMode,
    modelOverride
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
    approvalMode: parseApprovalMode(flags.approval)
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
  const runtimeConfig = loadRuntimeConfig({ workspaceRoot, approvalMode });
  const runtime = createToolRuntime(runtimeConfig);
  printModelRuntime(runtimeConfig);

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
      "  chat [--workspace <abs-path>] [--approval manual|auto|deny] [--model <name>]",
      "  (no command)                           等同于 chat，默认进入交互模式",
      "  greet [--time-based]                   显示中文问候语",
      "  hello [--time-based]                   显示中文问候语",
      "  agent run --task \"<task>\" [--workspace <abs-path>] [--approval manual|auto|deny]",
      "  agent chat [--workspace <abs-path>] [--approval manual|auto|deny] [--model <name>]",
      "  tools list [--workspace <abs-path>]",
      "  tools run <toolName> --args '{\"key\":\"value\"}' [--workspace <abs-path>] [--approval manual|auto|deny]",
      "  tools run <toolName> --args-file <json-file> [--workspace <abs-path>] [--approval manual|auto|deny]",
      "",
      "Model config:",
      "  Use chat /model commands to manage models",
      "  Store path: ~/.tuanzi/models.json",
      "  Runtime no longer falls back to env model keys",
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

async function handleGreet(flags: Record<string, string | boolean>): Promise<number> {
  const timeBased = flags["time-based"] === true;
  const greeting = getGreetingResponse(timeBased);
  console.log(greeting);
  return 0;
}
