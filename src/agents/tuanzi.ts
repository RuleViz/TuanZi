import type { ToolRegistry } from "../core/tool-registry";
import { parseJsonObject } from "../core/json-utils";
import type {
  CoderResult,
  McpDiscoveredTool,
  ModelFunctionToolDefinition,
  ToolCallRecord,
  ToolExecutionContext,
  ToolExecutionResult
} from "../core/types";
import type { StoredAgent } from "../core/agent-store";
import { resolveActiveTools } from "../core/agent-tooling";
import type { SkillCatalogItem } from "../core/skill-types";
import type { ChatCompletionClient, ChatInputImage } from "./model-types";
import { coderSystemPrompt } from "./prompts";
import { buildInitialPromptTokenBudget, loadProjectContextFromWorkspace } from "./project-context";
import { ReactToolAgent, type ToolLoopResumeState, type ToolLoopToolCallSnapshot } from "./react-tool-agent";

export class TuanZiAgent {
  constructor(
    private readonly client: ChatCompletionClient | null,
    private readonly model: string | null,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolContext: ToolExecutionContext,
    private readonly activeAgent: StoredAgent
  ) { }

  async execute(
    task: string,
    conversationContext = "",
    hooks?: {
      onAssistantTextDelta?: (delta: string) => void;
      onAssistantThinkingDelta?: (delta: string) => void;
      onToolCallCompleted?: (call: ToolLoopToolCallSnapshot) => void;
      onStateChange?: (state: ToolLoopResumeState) => void;
      resumeState?: ToolLoopResumeState;
      userImages?: ChatInputImage[];
      signal?: AbortSignal;
    }
  ): Promise<{
    result: CoderResult;
    toolCalls: ToolCallRecord[];
  }> {
    if (!this.client || !this.model) {
      return {
        result: fallbackCoderResult(),
        toolCalls: []
      };
    }

    const availableToolNames = this.toolRegistry.getToolNames();
    const activeTools = resolveActiveTools(this.activeAgent.tools, availableToolNames);
    this.toolContext.logger.info(
      `[agent] profile=${this.activeAgent.filename} activeTools=${activeTools.activeToolNames.length}`
    );
    const skillCatalog = listSkillCatalogSafely(this.toolContext);
    const projectContext = loadProjectContextFromWorkspace(this.toolContext.workspaceRoot, this.toolContext.logger);
    const tokenBudget = buildInitialPromptTokenBudget(this.toolContext.modelTokenBudget);
    const mcpTooling = await discoverMcpTooling(this.toolContext);
    const mergedAllowedTools = dedupeStrings([
      ...activeTools.activeToolNames,
      ...mcpTooling.allowedToolNames
    ]);
    this.toolContext.logger.info(
      `[agent] mcpTools=${mcpTooling.tools.length} mergedAllowedTools=${mergedAllowedTools.length}`
    );

    const agent = new ReactToolAgent(this.client, this.model, this.toolRegistry, this.toolContext);
    const userPromptSections = [
      "Task:",
      task,
      "",
      `Active agent: ${this.activeAgent.name}`,
      this.activeAgent.description ? `Agent description: ${this.activeAgent.description}` : ""
    ].filter((line) => line !== "");

    if (conversationContext) {
      userPromptSections.push(
        "",
        "Conversation memory from previous turns (context only, lower priority than current task):",
        conversationContext
      );
    }
    userPromptSections.push(
      "",
      "Handle the full task lifecycle: understand intent, inspect context if needed, use tools when required, and reply to the user in natural language.",
      "Output style requirement: keep wording professional and avoid unnecessary decorative symbols unless the user explicitly requests that style."
    );
    if (mcpTooling.tools.length > 0) {
      userPromptSections.push(
        "",
        "Connected external MCP tools (name prefix: mcp__). Use them when they improve correctness:",
        ...mcpTooling.tools.map((tool) => `- ${tool.namespacedName}: ${tool.description || "No description provided."}`)
      );
    }
    const userPrompt = userPromptSections.join("\n");

    const localToolInstructions = activeTools.activeTools.map((tool) => ({
      name: tool.name,
      prompt: tool.prompt
    }));
    const mcpToolInstructions = mcpTooling.tools.map((tool) => ({
      name: tool.namespacedName,
      prompt:
        `Use ${tool.namespacedName} when external MCP capability improves correctness, observability, or execution.` +
        ` ${tool.description || "No description provided."}`
    }));

    const systemPrompt = coderSystemPrompt({
      workspaceRoot: this.toolContext.workspaceRoot,
      agentName: this.activeAgent.name,
      agentPrompt: this.activeAgent.prompt,
      skillCatalog,
      projectContext,
      tokenBudget,
      toolInstructions: dedupeToolInstructions([...localToolInstructions, ...mcpToolInstructions])
    });

    const output = await agent.run({
      systemPrompt,
      userPrompt,
      userImages: hooks?.userImages,
      allowedTools: hooks?.resumeState?.allowedTools ?? mergedAllowedTools,
      additionalToolDefinitions: mcpTooling.modelToolDefinitions,
      maxTurns: this.toolContext.agentSettings?.toolLoop.coderMaxTurns ?? 20,
      temperature: 0.15,
      onAssistantTextDelta: hooks?.onAssistantTextDelta,
      onAssistantThinkingDelta: hooks?.onAssistantThinkingDelta,
      onToolCallCompleted: hooks?.onToolCallCompleted,
      onStateChange: hooks?.onStateChange,
      resumeState: hooks?.resumeState,
      signal: hooks?.signal
    });

    const toolCalls: ToolCallRecord[] = output.toolCalls.map((call) => ({
      toolName: call.name,
      args: call.args,
      result: call.result,
      timestamp: new Date().toISOString()
    }));
    const summary = extractUserFacingText(output.finalText);

    return {
      result: {
        summary,
        changedFiles: collectChangedFiles(toolCalls),
        executedCommands: collectExecutedCommands(toolCalls),
        followUp: []
      },
      toolCalls
    };
  }
}

function listSkillCatalogSafely(toolContext: ToolExecutionContext): SkillCatalogItem[] {
  const runtime = toolContext.skillRuntime;
  if (!runtime) {
    return [];
  }
  try {
    return runtime.listCatalog();
  } catch (error) {
    toolContext.logger.warn(`[skill] failed to load catalog: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

interface McpToolingSnapshot {
  tools: McpDiscoveredTool[];
  allowedToolNames: string[];
  modelToolDefinitions: ModelFunctionToolDefinition[];
}

async function discoverMcpTooling(toolContext: ToolExecutionContext): Promise<McpToolingSnapshot> {
  const bridge = toolContext.mcpBridge;
  if (!bridge || typeof bridge.listTools !== "function") {
    return {
      tools: [],
      allowedToolNames: [],
      modelToolDefinitions: []
    };
  }

  try {
    const tools = dedupeMcpTools(await bridge.listTools());
    if (tools.length === 0) {
      return {
        tools: [],
        allowedToolNames: [],
        modelToolDefinitions: []
      };
    }

    const modelToolDefinitions = await loadMcpToolDefinitions(bridge, tools);
    return {
      tools,
      allowedToolNames: tools.map((tool) => tool.namespacedName),
      modelToolDefinitions
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toolContext.logger.warn(`[agent] MCP discovery skipped due to error: ${message}`);
    return {
      tools: [],
      allowedToolNames: [],
      modelToolDefinitions: []
    };
  }
}

async function loadMcpToolDefinitions(
  bridge: ToolExecutionContext["mcpBridge"],
  tools: McpDiscoveredTool[]
): Promise<ModelFunctionToolDefinition[]> {
  if (bridge && typeof bridge.getModelToolDefinitions === "function") {
    const definitions = await bridge.getModelToolDefinitions();
    const names = new Set(tools.map((tool) => tool.namespacedName));
    return definitions.filter((definition) => names.has(definition.function.name));
  }
  return tools.map((tool) => toModelToolDefinition(tool));
}

function dedupeMcpTools(tools: McpDiscoveredTool[]): McpDiscoveredTool[] {
  const output: McpDiscoveredTool[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const namespacedName = tool.namespacedName?.trim();
    if (!namespacedName || seen.has(namespacedName)) {
      continue;
    }
    seen.add(namespacedName);
    output.push({
      serverId: tool.serverId,
      toolName: tool.toolName,
      namespacedName,
      description: tool.description || "",
      inputSchema: tool.inputSchema
    });
  }
  return output;
}

function toModelToolDefinition(tool: McpDiscoveredTool): ModelFunctionToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.namespacedName,
      description: tool.description || `MCP tool ${tool.serverId}::${tool.toolName}`,
      parameters: normalizeMcpInputSchema(tool.inputSchema)
    }
  };
}

function normalizeMcpInputSchema(inputSchema: Record<string, unknown>): Record<string, unknown> {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return {
      type: "object",
      properties: {},
      additionalProperties: true
    };
  }
  const schema = { ...inputSchema };
  if (schema.type !== "object") {
    schema.type = "object";
  }
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    schema.properties = {};
  }
  if (!Object.prototype.hasOwnProperty.call(schema, "additionalProperties")) {
    schema.additionalProperties = true;
  }
  return schema;
}

function dedupeStrings(values: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function dedupeToolInstructions(
  values: Array<{ name: string; prompt: string }>
): Array<{ name: string; prompt: string }> {
  const output: Array<{ name: string; prompt: string }> = [];
  const seen = new Set<string>();
  for (const value of values) {
    const name = value.name.trim();
    const prompt = value.prompt.trim();
    if (!name || !prompt || seen.has(name)) {
      continue;
    }
    seen.add(name);
    output.push({ name, prompt });
  }
  return output;
}

function collectChangedFiles(toolCalls: ToolCallRecord[]): string[] {
  const fileTools = new Set(["write", "edit", "delete_file"]);
  const paths = new Set<string>();

  for (const call of toolCalls) {
    if (!fileTools.has(call.toolName)) {
      continue;
    }
    if (!call.result.ok || !call.result.data || typeof call.result.data !== "object" || Array.isArray(call.result.data)) {
      continue;
    }

    const data = call.result.data as Record<string, unknown>;
    const possiblePathKeys = ["path", "targetFile", "deletedPath"];
    for (const key of possiblePathKeys) {
      const value = data[key];
      if (typeof value === "string") {
        paths.add(value);
      }
    }
  }

  return [...paths];
}

function collectExecutedCommands(toolCalls: ToolCallRecord[]): Array<{ command: string; exitCode: number | null }> {
  const commands: Array<{ command: string; exitCode: number | null }> = [];
  for (const call of toolCalls) {
    if (call.toolName !== "bash") {
      continue;
    }
    const commandFromArgs = typeof call.args.command === "string" ? call.args.command : null;
    let commandFromData: string | null = null;
    let exitCode: number | null = null;

    if (call.result.data && typeof call.result.data === "object" && !Array.isArray(call.result.data)) {
      const data = call.result.data as Record<string, unknown>;
      commandFromData = typeof data.command === "string" ? data.command : null;
      exitCode = typeof data.exitCode === "number" ? data.exitCode : null;
    }
    const command = commandFromData ?? commandFromArgs;
    if (command) {
      commands.push({ command, exitCode });
    }
  }
  return commands;
}

function fallbackCoderResult(): CoderResult {
  return {
    summary:
      "未配置模型（未命中 ~/.tuanzi/models.json 的 defaultModel 或会话别名，且 ~/.tuanzi/config.json provider 未配置），团子进入降级模式。",
    changedFiles: [],
    executedCommands: [],
    followUp: [
      "在 chat 里使用 /model add 和 /model use 设置模型，或配置 ~/.tuanzi/config.json 的 provider 后重试。"
    ]
  };
}

function extractUserFacingText(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return "TuanZi completed but returned an empty response.";
  }

  const maybeJsonSummary = tryExtractJsonSummary(trimmed);
  const source = maybeJsonSummary ?? trimmed;
  const lines = source.split(/\r?\n/);
  const filtered = lines.filter((line) => !isMetaNarrationLine(line.trim()));
  return (filtered.length > 0 ? filtered.join("\n") : source).trim();
}

function tryExtractJsonSummary(text: string): string | null {
  const parsed = parseJsonObject(text);
  if (!parsed || typeof parsed.summary !== "string" || !parsed.summary.trim()) {
    return null;
  }
  return parsed.summary;
}

function isMetaNarrationLine(line: string): boolean {
  const patterns = [
    /^用户(发送了|询问了|提问了|要求|请求)/,
    /^我已(经)?(友好回应|回复|完成|准备)/,
    /^这是(我|系统).*(记录|总结)/,
    /^以下是(对话|聊天).*(记录|总结)/
  ];
  return patterns.some((pattern) => pattern.test(line));
}
