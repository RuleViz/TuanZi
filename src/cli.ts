import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadRuntimeConfig } from "./config";
import type { ApprovalMode } from "./core/approval-gate";
import type { JsonObject } from "./core/types";
import { createOrchestrator, createToolRuntime } from "./runtime";
import { startWebServer } from "./web/server";
import { getGreetingResponse } from "./greeting";

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const [mainCommand, subCommand, ...restPositionals] = parsed.positionals;

  if (!mainCommand || mainCommand === "help" || mainCommand === "--help" || mainCommand === "-h") {
    printHelp();
    return 0;
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
  if (mainCommand === "web" && subCommand === "start") {
    return handleWebStart(parsed.flags);
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

  let task = typeof flags.task === "string" ? flags.task.trim() : "";
  if (!task) {
    task = await promptTask();
  }
  if (!task) {
    console.error("Task cannot be empty.");
    return 1;
  }

  const orchestrator = createOrchestrator(runtimeConfig, runtime);
  runtime.logger.info("Running Plan -> Search -> Code loop ...");
  const result = await orchestrator.run(task);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

async function handleWebStart(flags: Record<string, string | boolean>): Promise<number> {
  const workspaceRoot = resolveWorkspace(flags.workspace as string | undefined);
  const approvalMode = parseApprovalMode(flags.approval);
  const host = typeof flags.host === "string" && flags.host.trim() ? flags.host.trim() : "127.0.0.1";
  const port = parsePort(flags.port);

  const server = await startWebServer({
    workspaceRoot,
    approvalMode,
    host,
    port
  });

  console.log(`Web UI started: ${server.url}`);
  console.log("Press Ctrl+C to stop.");

  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      await server.close().catch(() => {});
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

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

function parsePort(rawPort: string | boolean | undefined): number {
  if (typeof rawPort !== "string") {
    return 3000;
  }
  const parsed = Number(rawPort);
  if (!Number.isFinite(parsed)) {
    return 3000;
  }
  const intValue = Math.floor(parsed);
  if (intValue < 1 || intValue > 65535) {
    return 3000;
  }
  return intValue;
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
      "MyCoderAgent MVP CLI",
      "",
      "Commands:",
      "  greet [--time-based]                   显示中文问候语",
      "  hello [--time-based]                   显示中文问候语",
      "  agent run --task \"<task>\" [--workspace <abs-path>] [--approval manual|auto|deny]",
      "  web start [--workspace <abs-path>] [--approval manual|auto|deny] [--host 127.0.0.1] [--port 3000]",
      "  tools list [--workspace <abs-path>]",
      "  tools run <toolName> --args '{\"key\":\"value\"}' [--workspace <abs-path>] [--approval manual|auto|deny]",
      "  tools run <toolName> --args-file <json-file> [--workspace <abs-path>] [--approval manual|auto|deny]",
      "",
      "Model env vars (OpenAI-compatible):",
      "  MYCODER_API_BASE_URL   optional override; defaults follow API key source",
      "  MYCODER_API_KEY",
      "  QWEN_API_KEY          fallback if MYCODER_API_KEY is not set (default base/model: DashScope + qwen3.5-plus)",
      "  DEEPSEEK_API_KEY      fallback after QWEN_API_KEY (default base/model: DeepSeek + deepseek-chat)",
      "  MYCODER_MODEL          shared model for all agents (optional override)",
      "  MYCODER_PLANNER_MODEL  optional override",
      "  MYCODER_SEARCH_MODEL   optional override",
      "  MYCODER_CODER_MODEL    optional override",
      "",
      "Project config file:",
      "  agent.config.json      routing/policy/webSearch/toolLoop/mcp settings"
    ].join("\n")
  );
}

async function handleGreet(flags: Record<string, string | boolean>): Promise<number> {
  const timeBased = flags["time-based"] === true;
  const greeting = getGreetingResponse(timeBased);
  console.log(greeting);
  return 0;
}
