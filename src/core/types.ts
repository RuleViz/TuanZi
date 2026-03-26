import type { SkillRuntime } from "./skill-types";

export type JsonObject = Record<string, unknown>;

export type PolicyDecision = "allow" | "ask" | "deny";

export interface RoutingSettings {
  enableDirectMode: boolean;
  directIntentPatterns: string[];
  defaultEnablePlanMode: boolean;
}

export interface PolicySettings {
  default: PolicyDecision;
  tools: Record<string, PolicyDecision>;
  commandRules: {
    deny: string[];
    allow: string[];
  };
}

export interface WebSearchSettings {
  enabled: boolean;
  provider: "mcp";
  maxUsesPerTask: number;
  maxResultsPerUse: number;
  maxCharsPerPage: number;
  cacheTtlMs: number;
}

export interface ToolLoopSettings {
  searchMaxTurns: number;
  coderMaxTurns: number;
  noProgressRepeatTurns: number;
}

export interface ModelRequestSettings {
  reasoningEffort: "low" | "medium" | "high" | null;
  thinking: {
    type: "enabled" | "disabled" | null;
    budgetTokens: number | null;
  };
  extraBody: JsonObject;
}

export interface AgentSettings {
  routing: RoutingSettings;
  policy: PolicySettings;
  webSearch: WebSearchSettings;
  toolLoop: ToolLoopSettings;
  mcp: McpSettings;
  modelRequest: ModelRequestSettings;
}

export interface PolicyEvaluation {
  decision: PolicyDecision;
  reason: string;
}

export interface PolicyEngine {
  evaluateTool(toolName: string, args: JsonObject): PolicyEvaluation;
}

export interface McpSettings {
  enabled: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
}

export interface McpToolCallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface ModelFunctionToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonObject;
  };
}

export interface McpDiscoveredTool {
  serverId: string;
  toolName: string;
  namespacedName: string;
  description: string;
  inputSchema: JsonObject;
}

export interface McpBridge {
  callTool(name: string, args: JsonObject, options?: { signal?: AbortSignal }): Promise<McpToolCallResult>;
  listTools?(): Promise<McpDiscoveredTool[]>;
  getModelToolDefinitions?(): Promise<ModelFunctionToolDefinition[]>;
}

export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type SubagentTaskKind = "explorer";

export interface SubagentToolCallRecord {
  id: string;
  name: string;
  args: JsonObject;
  result: ToolExecutionResult;
}

export interface SubagentResultSummary {
  summary: string;
  fullText: string;
  references: SearchReference[];
  webReferences: Array<{ url: string; reason: string }>;
  toolCalls: SubagentToolCallRecord[];
  error?: string;
  completedAt: string;
}

export interface SubagentSnapshot {
  id: string;
  parentTaskId: string | null;
  kind: SubagentTaskKind;
  status: SubagentStatus;
  task: string;
  context: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: SubagentResultSummary | null;
}

export interface SubagentBridge {
  spawn(input: {
    task: string;
    context?: string;
    agentType?: SubagentTaskKind;
  }): Promise<{ subagentId: string; status: SubagentStatus }>;
  wait(input?: {
    ids?: string[];
    waitMode?: "all" | "any";
    timeoutMs?: number;
  }): Promise<{
    completed: SubagentSnapshot[];
    pending: SubagentSnapshot[];
    timedOut: boolean;
  }>;
  list(status?: SubagentStatus): Promise<SubagentSnapshot[]>;
  dispose(): Promise<void>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonObject;
  destructive?: boolean;
  readOnly?: boolean;
}

export interface ToolExecutionResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ApprovalRequest {
  requestType?: "tool" | "plan" | "step";
  action: string;
  risk: "low" | "medium" | "high";
  preview?: string;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

export interface ApprovalGate {
  approve(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface BackupManager {
  backupFile(absoluteFilePath: string): Promise<string | null>;
}

export interface UserQuestionOption {
  label: string;
  description?: string;
  value: string;
}

export interface UserQuestionField {
  id: string;
  type: "single_select" | "multi_select" | "text";
  question: string;
  options?: UserQuestionOption[];
  placeholder?: string;
  required?: boolean;
  default_value?: string | string[];
}

export interface UserQuestionRequest {
  requestId: string;
  title?: string;
  description?: string;
  fields: UserQuestionField[];
}

export interface UserQuestionAnswer {
  requestId: string;
  answers: Record<string, string | string[]>;
  skipped?: boolean;
}

export interface UserInteractionBridge {
  askQuestion(request: UserQuestionRequest): Promise<UserQuestionAnswer>;
}

export interface ToolExecutionContext {
  workspaceRoot: string;
  approvalGate: ApprovalGate;
  backupManager: BackupManager;
  logger: Logger;
  modelTokenBudget?: {
    total: number;
    reserve: number;
    limit: number;
  };
  policyEngine?: PolicyEngine;
  agentSettings?: AgentSettings;
  taskId?: string;
  sessionId?: string;
  mcpBridge?: McpBridge;
  subagentBridge?: SubagentBridge;
  skillRuntime?: SkillRuntime;
  terminalBridge?: TerminalBridge;
  userInteractionBridge?: UserInteractionBridge;
  signal?: AbortSignal;
}

export interface TerminalCommandResult {
  terminalId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  interrupted: boolean;
}

export interface TerminalBridge {
  executeCommand(input: {
    sessionId: string;
    workspaceRoot: string;
    cwd: string;
    command: string;
    env: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
    terminalId?: string;
    title?: string;
  }): Promise<TerminalCommandResult>;
}

export interface Tool {
  definition: ToolDefinition;
  execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export interface ToolCallRecord {
  toolName: string;
  args: JsonObject;
  result: ToolExecutionResult;
  timestamp: string;
}

export interface PlanStep {
  id: string;
  title: string;
  owner: "search" | "code";
  acceptance: string;
  description?: string;
  files?: string[];
}

export interface ExecutionPlan {
  goal: string;
  title?: string;
  steps: PlanStep[];
  suggestedTestCommand?: string;
  instruction?: string;
}

export interface SearchReference {
  path: string;
  reason: string;
  confidence: "low" | "medium" | "high";
}

export interface SearchResult {
  summary: string;
  references: SearchReference[];
  webReferences: Array<{ url: string; reason: string }>;
}

export interface CoderResult {
  summary: string;
  changedFiles: string[];
  executedCommands: Array<{ command: string; exitCode: number | null }>;
  followUp: string[];
}
