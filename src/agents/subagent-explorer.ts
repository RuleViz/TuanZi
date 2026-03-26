import { parseJsonObject } from "../core/json-utils";
import type {
  McpDiscoveredTool,
  ModelFunctionToolDefinition,
  SearchReference,
  SearchResult,
  SubagentResultSummary,
  ToolExecutionContext,
  ToolExecutionResult
} from "../core/types";
import type { ChatCompletionClient } from "./model-types";
import { subagentExplorerSystemPrompt } from "./prompts";
import { buildInitialPromptTokenBudget, loadProjectContextFromWorkspace } from "./project-context";
import { ReactToolAgent, type ToolLoopToolCallSnapshot } from "./react-tool-agent";
import type { ToolRegistry } from "../core/tool-registry";

const BASE_EXPLORER_TOOLS = ["ls", "glob", "grep", "read", "browser_action"];
const READ_ONLY_MCP_NAME_PATTERNS = [
  /^mcp__.*__(get|list|search|find|fetch|query|read|browse)/i,
  /^mcp__.*__(lookup|inspect)/i
];

export class SubagentExplorerAgent {
  constructor(
    private readonly client: ChatCompletionClient | null,
    private readonly model: string | null,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolContext: ToolExecutionContext
  ) { }

  async run(input: {
    task: string;
    context?: string;
    signal?: AbortSignal;
  }): Promise<SubagentResultSummary> {
    throwIfAborted(input.signal);
    if (!this.client || !this.model) {
      return {
        summary: "Explorer subagent fallback mode is unavailable because no model is configured.",
        fullText: "Explorer subagent fallback mode is unavailable because no model is configured.",
        references: [],
        webReferences: [],
        toolCalls: [],
        completedAt: new Date().toISOString()
      };
    }

    const mcpTools = await discoverReadOnlyMcpTools(this.toolContext);
    const allowedTools = [...BASE_EXPLORER_TOOLS, ...mcpTools.map((tool) => tool.namespacedName)];
    const additionalToolDefinitions = mcpTools.map((tool) => toModelToolDefinition(tool));
    const userPrompt = buildUserPrompt(input.task, input.context ?? "");
    const projectContext = loadProjectContextFromWorkspace(this.toolContext.workspaceRoot, this.toolContext.logger);
    const tokenBudget = buildInitialPromptTokenBudget(this.toolContext.modelTokenBudget);
    const agent = new ReactToolAgent(
      this.client,
      this.model,
      this.toolRegistry,
      createSubagentToolContext(this.toolContext)
    );
    const output = await agent.run({
      systemPrompt: subagentExplorerSystemPrompt({
        workspaceRoot: this.toolContext.workspaceRoot,
        enabledTools: allowedTools,
        projectContext,
        tokenBudget
      }),
      userPrompt,
      allowedTools,
      additionalToolDefinitions,
      maxTurns: this.toolContext.agentSettings?.toolLoop.searchMaxTurns ?? 8,
      temperature: 0.1,
      signal: input.signal
    });

    const parsed = parseJsonObject(output.finalText);
    const completedAt = new Date().toISOString();
    if (!parsed) {
      const fallback = fallbackResultFromToolCalls(output.toolCalls, output.finalText);
      if (fallback) {
        return {
          ...fallback,
          completedAt
        };
      }
      return {
        summary: output.finalText.trim() || "Explorer subagent completed with unstructured output.",
        fullText: output.finalText,
        references: [],
        webReferences: [],
        toolCalls: output.toolCalls.map(cloneToolCallSnapshot),
        completedAt
      };
    }

    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "Explorer subagent completed.",
      fullText: output.finalText,
      references: Array.isArray(parsed.references)
        ? parsed.references.map(toSearchReference).filter((item): item is SearchReference => item !== null)
        : [],
      webReferences: Array.isArray(parsed.webReferences)
        ? parsed.webReferences
          .map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
              return null;
            }
            const record = item as Record<string, unknown>;
            const url = typeof record.url === "string" ? record.url : null;
            const reason = typeof record.reason === "string" ? record.reason : "";
            if (!url) {
              return null;
            }
            return { url, reason };
          })
          .filter((item): item is { url: string; reason: string } => item !== null)
        : [],
      toolCalls: output.toolCalls.map(cloneToolCallSnapshot),
      completedAt
    };
  }
}

function createSubagentToolContext(base: ToolExecutionContext): ToolExecutionContext {
  return {
    ...base,
    logger: {
      info: (message: string): void => {
        base.logger.info(prefixSubagentLog(message));
      },
      warn: (message: string): void => {
        base.logger.warn(prefixSubagentLog(message));
      },
      error: (message: string): void => {
        base.logger.error(prefixSubagentLog(message));
      }
    },
    subagentBridge: undefined
  };
}

function prefixSubagentLog(message: string): string {
  const idMatch = message.match(/\bid=([^\s]+)/);
  const label = idMatch?.[1] ? `[subagent:${idMatch[1]}]` : "[subagent]";
  return `${label} ${message}`;
}

function buildUserPrompt(task: string, context: string): string {
  const sections = ["Delegated task:", task];
  if (context.trim()) {
    sections.push("", "Parent context:", context.trim());
  }
  sections.push(
    "",
    "Collect evidence only. Focus on candidate files, code locations, or web facts that the parent agent can summarize later."
  );
  return sections.join("\n");
}

async function discoverReadOnlyMcpTools(toolContext: ToolExecutionContext): Promise<McpDiscoveredTool[]> {
  const bridge = toolContext.mcpBridge;
  if (!bridge || typeof bridge.listTools !== "function") {
    return [];
  }
  try {
    const tools = await bridge.listTools();
    return tools.filter((tool) =>
      READ_ONLY_MCP_NAME_PATTERNS.some((pattern) => pattern.test(tool.namespacedName))
    );
  } catch (error) {
    toolContext.logger.warn(
      `[subagent] failed to list MCP tools: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
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
  if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    schema.properties = {};
  }
  if (!Object.prototype.hasOwnProperty.call(schema, "additionalProperties")) {
    schema.additionalProperties = true;
  }
  return schema;
}

function toSearchReference(value: unknown): SearchReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : null;
  const reason = typeof record.reason === "string" ? record.reason : "";
  const confidence =
    record.confidence === "low" || record.confidence === "medium" || record.confidence === "high"
      ? record.confidence
      : "medium";
  if (!path) {
    return null;
  }
  return { path, reason, confidence };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Interrupted by user");
  }
}

function fallbackResultFromToolCalls(
  toolCalls: ToolLoopToolCallSnapshot[],
  finalText: string
): Omit<SubagentResultSummary, "completedAt"> | null {
  if (toolCalls.length === 0) {
    return null;
  }

  const references: SearchReference[] = [];
  const webReferences: Array<{ url: string; reason: string }> = [];
  let successfulCalls = 0;

  for (const call of toolCalls) {
    if (!call.result.ok) {
      continue;
    }
    successfulCalls += 1;
    collectReferenceCandidates(call, references, webReferences);
  }

  const normalizedSummary = finalText.trim();
  const genericTermination = isGenericToolLoopTermination(normalizedSummary);
  if (!genericTermination && references.length === 0 && webReferences.length === 0) {
    return null;
  }

  return {
    summary: genericTermination
      ? buildEvidenceFallbackSummary(normalizedSummary, successfulCalls, references.length, webReferences.length)
      : normalizedSummary,
    fullText: finalText,
    references: uniqueReferences(references),
    webReferences: uniqueWebReferences(webReferences),
    toolCalls: toolCalls.map(cloneToolCallSnapshot)
  };
}

function collectReferenceCandidates(
  call: ToolLoopToolCallSnapshot,
  references: SearchReference[],
  webReferences: Array<{ url: string; reason: string }>
): void {
  if (!call.result.data || typeof call.result.data !== "object" || Array.isArray(call.result.data)) {
    return;
  }

  const data = call.result.data as Record<string, unknown>;

  if (call.name === "read") {
    const fileRecord =
      data.file && typeof data.file === "object" && !Array.isArray(data.file)
        ? (data.file as Record<string, unknown>)
        : null;
    const path = typeof fileRecord?.path === "string" ? fileRecord.path : null;
    if (path) {
      references.push({
        path,
        reason: "Read during subagent exploration.",
        confidence: "high"
      });
    }
    return;
  }

  if (call.name === "glob") {
    const matches = Array.isArray(data.matches) ? data.matches : [];
    for (const match of matches) {
      if (!match || typeof match !== "object" || Array.isArray(match)) {
        continue;
      }
      const record = match as Record<string, unknown>;
      const absolutePath = typeof record.absolutePath === "string" ? record.absolutePath : null;
      if (!absolutePath) {
        continue;
      }
      references.push({
        path: absolutePath,
        reason: "Matched during subagent exploration.",
        confidence: "medium"
      });
    }
    return;
  }

  if (call.name === "grep") {
    const hits = Array.isArray(data.hits) ? data.hits : [];
    const query = typeof data.query === "string" && data.query.trim() ? data.query.trim() : null;
    for (const hit of hits) {
      if (!hit || typeof hit !== "object" || Array.isArray(hit)) {
        continue;
      }
      const record = hit as Record<string, unknown>;
      const file = typeof record.file === "string" ? record.file : null;
      if (!file) {
        continue;
      }
      references.push({
        path: file,
        reason: query ? `Matched grep query "${query}".` : "Matched during subagent grep search.",
        confidence: "high"
      });
    }
    return;
  }

  if (call.name === "browser_action") {
    const action = typeof data.action === "string" ? data.action : null;
    const url = typeof data.url === "string" ? data.url : null;
    if (action === "navigate" && url) {
      webReferences.push({
        url,
        reason: "Visited during subagent exploration."
      });
    }
    return;
  }

  if (call.name.startsWith("mcp__")) {
    collectMcpWebReferences(data, webReferences);
  }
}

function collectMcpWebReferences(
  data: Record<string, unknown>,
  webReferences: Array<{ url: string; reason: string }>
): void {
  const seen = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    const record = value as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url : null;
    if (url && !seen.has(url)) {
      seen.add(url);
      webReferences.push({
        url,
        reason: "Referenced by MCP search results."
      });
    }
    for (const child of Object.values(record)) {
      visit(child);
    }
  };
  visit(data);
}

function isGenericToolLoopTermination(summary: string): boolean {
  const normalized = summary.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "tool loop reached max turns without final assistant output." ||
    normalized === "tool loop stopped due to repeated no-progress tool calls."
  );
}

function buildEvidenceFallbackSummary(
  finalText: string,
  successfulCalls: number,
  referenceCount: number,
  webReferenceCount: number
): string {
  const coverageParts: string[] = [];
  if (referenceCount > 0) {
    coverageParts.push(`${referenceCount} repo reference${referenceCount === 1 ? "" : "s"}`);
  }
  if (webReferenceCount > 0) {
    coverageParts.push(`${webReferenceCount} web reference${webReferenceCount === 1 ? "" : "s"}`);
  }
  if (coverageParts.length === 0) {
    coverageParts.push(`${successfulCalls} successful tool call${successfulCalls === 1 ? "" : "s"}`);
  }

  const stopReason = finalText.toLowerCase().includes("no-progress")
    ? "the no-progress breaker stopped further exploration"
    : "the tool loop reached its turn limit";

  return `Explorer gathered evidence from tool calls before ${stopReason}. Collected ${coverageParts.join(" and ")}.`;
}

function uniqueReferences(references: SearchReference[]): SearchReference[] {
  const output: SearchReference[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const key = `${reference.path}::${reference.reason}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(reference);
  }
  return output;
}

function uniqueWebReferences(
  references: Array<{ url: string; reason: string }>
): Array<{ url: string; reason: string }> {
  const output: Array<{ url: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const key = `${reference.url}::${reference.reason}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(reference);
  }
  return output;
}

function cloneToolCallSnapshot(call: ToolLoopToolCallSnapshot): ToolLoopToolCallSnapshot {
  return {
    id: call.id,
    name: call.name,
    args: JSON.parse(JSON.stringify(call.args)),
    result: JSON.parse(JSON.stringify(call.result))
  };
}
