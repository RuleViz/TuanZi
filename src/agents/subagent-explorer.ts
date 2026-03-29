import { parseJsonObject } from "../core/json-utils";
import type {
  AgentResult,
  McpDiscoveredTool,
  ModelFunctionToolDefinition,
  SearchReference,
  SubagentToolCallRecord,
  SubagentContextResult,
  SubagentResultSummary,
  ToolExecutionContext,
  ToolExecutionResult
} from "../core/types";
import type { ChatCompletionClient, ChatMessage } from "./model-types";
import { subagentExplorerSystemPrompt } from "./prompts";
import { buildInitialPromptTokenBudget, loadProjectContextFromWorkspace } from "./project-context";
import { ReactToolAgent, type ToolLoopResumeState, type ToolLoopToolCallSnapshot } from "./react-tool-agent";

export interface SubagentStreamCallbacks {
  onThinkingDelta?: (delta: string) => void;
  onTextDelta?: (delta: string) => void;
  onToolStart?: (toolCallId: string, toolName: string, args: Record<string, unknown>) => void;
  onToolEnd?: (toolCallId: string, toolName: string, result: { ok: boolean; data?: unknown; error?: string }) => void;
}
import type { ToolRegistry } from "../core/tool-registry";
import { SubagentSessionStore } from "./subagent-session-store";

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
    private readonly toolContext: ToolExecutionContext,
    private readonly sessionStore: SubagentSessionStore = new SubagentSessionStore(toolContext.workspaceRoot)
  ) { }

  async run(input: {
    agentId?: string;
    task: string;
    context?: string;
    resumeFromSnapshotId?: string;
    signal?: AbortSignal;
    streamCallbacks?: SubagentStreamCallbacks;
  }): Promise<SubagentResultSummary> {
    if (input.signal?.aborted) {
      return buildSubagentResult({
        summary: "Subagent interrupted.",
        exitReason: "interrupted",
        error: "Interrupted by user",
        messages: [],
        toolCalls: [],
        fullTextPreview: "Interrupted by user."
      });
    }
    if (!this.client || !this.model) {
      return buildSubagentResult({
        summary: "Explorer subagent fallback mode is unavailable because no model is configured.",
        exitReason: "error",
        error: "Explorer subagent fallback mode is unavailable because no model is configured.",
        messages: [],
        toolCalls: [],
        fullTextPreview: "Explorer subagent fallback mode is unavailable because no model is configured."
      });
    }
    const sessionId = getRequiredSessionId(this.toolContext);
    if (!sessionId) {
      return buildSubagentResult({
        summary: "Subagent sessionId is required for snapshot persistence.",
        exitReason: "error",
        error: "sessionId is required.",
        messages: [],
        toolCalls: [],
        fullTextPreview: "Subagent sessionId is required for snapshot persistence."
      });
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
    const agentId = input.agentId ?? input.resumeFromSnapshotId ?? "subagent";
    const resumeState = input.resumeFromSnapshotId
      ? await this.loadResumeState({
        sessionId,
        snapshotId: input.resumeFromSnapshotId,
        followUpTask: input.task,
        followUpContext: input.context ?? ""
      })
      : null;
    let latestResumeState: ToolLoopResumeState | null = resumeState;

    try {
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
        resumeState,
        onStateChange: (state) => {
          latestResumeState = state;
        },
        onAssistantThinkingDelta: input.streamCallbacks?.onThinkingDelta,
        onAssistantTextDelta: input.streamCallbacks?.onTextDelta,
        onToolCallStart: input.streamCallbacks?.onToolStart,
        onToolCallCompleted: input.streamCallbacks ? (call) => {
          input.streamCallbacks?.onToolEnd?.(call.id, call.name, call.result);
        } : undefined,
        signal: input.signal
      });

      const parsed = parseJsonObject(output.data.finalText);
      const result = buildSubagentResultFromOutput(output, parsed);
      await this.saveSnapshot({
        sessionId,
        agentId,
        task: input.task,
        context: input.context ?? "",
        resumeState: latestResumeState ?? output.data.resumeState
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.toolContext.logger.warn(`[subagent] error: ${message}`);
      await this.saveSnapshot({
        sessionId,
        agentId,
        task: input.task,
        context: input.context ?? "",
        resumeState: latestResumeState
      });
      return buildSubagentResult({
        summary: `Subagent encountered an error: ${message}`,
        exitReason: "error",
        error: message,
        messages: latestResumeState?.messages ?? [],
        toolCalls: latestResumeState?.toolCalls ?? [],
        fullTextPreview: `Subagent encountered an error: ${message}`,
        conversationSnapshot: latestResumeState
          ? {
            messages: latestResumeState.messages,
            resumeState: latestResumeState
          }
          : undefined
      });
    }
  }

  private async loadResumeState(input: {
    sessionId: string;
    snapshotId: string;
    followUpTask: string;
    followUpContext: string;
  }): Promise<ToolLoopResumeState> {
    const stored = await this.sessionStore.load({
      sessionId: input.sessionId,
      agentId: input.snapshotId
    });
    const resumeState = stored.conversationSnapshot.resumeState as ToolLoopResumeState;
    const messages = Array.isArray(resumeState.messages) ? [...resumeState.messages] : [];
    messages.push({
      role: "user",
      content: buildResumePrompt(input.followUpTask, input.followUpContext)
    });
    return {
      ...resumeState,
      messages
    };
  }

  private async saveSnapshot(input: {
    sessionId: string;
    agentId: string;
    task: string;
    context: string;
    resumeState: ToolLoopResumeState | null;
  }): Promise<void> {
    if (!input.resumeState) {
      return;
    }
    await this.sessionStore.save({
      sessionId: input.sessionId,
      agentId: input.agentId,
      task: input.task,
      context: input.context,
      conversationSnapshot: {
        messages: input.resumeState.messages,
        resumeState: input.resumeState
      }
    });
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

function buildResumePrompt(task: string, context: string): string {
  const sections = ["Resume the previous delegated task with this follow-up:" , task];
  if (context.trim()) {
    sections.push("", "Additional parent context:", context.trim());
  }
  return sections.join("\n");
}

function buildSubagentResultFromOutput(
  output: AgentResult<{ finalText: string; resumeState: ToolLoopResumeState | null }, ChatMessage, ToolLoopToolCallSnapshot>,
  parsed: Record<string, unknown> | null
): SubagentResultSummary {
  const summary =
    parsed && typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : output.error
        ? `Subagent encountered an error: ${output.error}`
        : output.data.finalText.trim() || "Explorer subagent completed.";
  const references =
    parsed && Array.isArray(parsed.references)
      ? parsed.references.map(toSearchReference).filter((item): item is SearchReference => item !== null)
      : [];
  const webReferences =
    parsed && Array.isArray(parsed.webReferences)
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
      : [];
  const parseError =
    parsed || output.exitReason === "interrupted" || output.exitReason === "completed"
      ? output.error
      : output.error ?? "Subagent returned unstructured output.";

  return buildSubagentResult({
    summary,
    exitReason: parsed ? output.exitReason : "error",
    ...(parseError ? { error: parseError } : {}),
    messages: output.context.messages,
    toolCalls: output.context.toolCalls,
    references,
    webReferences,
    fullTextPreview: buildPreviewText(output.data.finalText),
    toolCallPreview: buildToolCallPreview(output.context.toolCalls),
    conversationSnapshot: output.data.resumeState
      ? {
        messages: output.data.resumeState.messages,
        resumeState: output.data.resumeState
      }
      : undefined
  });
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

function getRequiredSessionId(toolContext: ToolExecutionContext): string | null {
  return typeof toolContext.sessionId === "string" && toolContext.sessionId.trim() ? toolContext.sessionId.trim() : null;
}

function buildSubagentResult(input: {
  summary: string;
  exitReason: SubagentResultSummary["exitReason"];
  error?: string;
  messages: ChatMessage[];
  toolCalls: ToolLoopToolCallSnapshot[];
  references?: SearchReference[];
  webReferences?: Array<{ url: string; reason: string }>;
  fullTextPreview?: string;
  toolCallPreview?: SubagentContextResult["toolCallPreview"];
  conversationSnapshot?: {
    messages: ChatMessage[];
    resumeState: ToolLoopResumeState;
  };
}): SubagentResultSummary {
  return {
    data: {
      summary: input.summary,
      references: input.references ?? [],
      webReferences: input.webReferences ?? [],
      ...(input.fullTextPreview ? { fullTextPreview: input.fullTextPreview } : {}),
      ...(input.toolCallPreview ? { toolCallPreview: input.toolCallPreview } : {}),
      metadata: {
        toolCalls: input.toolCalls.map(cloneToolCallSnapshot),
        turnCount: resolveTurnCount(input.conversationSnapshot?.resumeState ?? null, input.messages),
        completedAt: new Date().toISOString(),
        ...(input.error ? { error: input.error } : {})
      },
      ...(input.conversationSnapshot
        ? {
          conversationSnapshot: {
            messages: cloneMessages(input.conversationSnapshot.messages),
            resumeState: cloneResumeState(input.conversationSnapshot.resumeState)
          }
        }
        : {})
    },
    exitReason: input.exitReason,
    ...(input.error ? { error: input.error } : {}),
    context: {
      messages: cloneMessages(input.messages),
      toolCalls: input.toolCalls.map(cloneToolCallSnapshot)
    }
  };
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

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return JSON.parse(JSON.stringify(messages)) as ChatMessage[];
}

function cloneResumeState(state: ToolLoopResumeState): ToolLoopResumeState {
  return JSON.parse(JSON.stringify(state)) as ToolLoopResumeState;
}

function buildPreviewText(text: string, maxLength = 400): string {
  const normalized = text.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const headLength = Math.floor((maxLength - 5) / 2);
  const tailLength = maxLength - headLength - 5;
  return `${normalized.slice(0, headLength)}\n...\n${normalized.slice(normalized.length - tailLength)}`;
}

function buildToolCallPreview(toolCalls: ToolLoopToolCallSnapshot[]): SubagentToolCallRecord[] {
  return toolCalls.slice(0, 3).map((call) => ({
    id: call.id,
    name: call.name,
    args: truncateJsonObject(call.args, 240),
    result: truncateToolExecutionResult(call.result, 320)
  }));
}

function truncateJsonObject(value: Record<string, unknown>, maxLength: number): Record<string, unknown> {
  const text = JSON.stringify(value);
  if (text.length <= maxLength) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  return {
    preview: `${text.slice(0, Math.max(1, maxLength - 3))}...`
  };
}

function truncateToolExecutionResult(result: ToolExecutionResult, maxLength: number): ToolExecutionResult {
  const text = JSON.stringify(result);
  if (text.length <= maxLength) {
    return JSON.parse(text) as ToolExecutionResult;
  }
  return {
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
    data: `${text.slice(0, Math.max(1, maxLength - 3))}...`
  };
}

function resolveTurnCount(resumeState: ToolLoopResumeState | null, messages: ChatMessage[]): number {
  if (resumeState && typeof resumeState.nextTurn === "number") {
    return resumeState.nextTurn;
  }
  return messages.filter((message) => message.role === "assistant").length;
}
