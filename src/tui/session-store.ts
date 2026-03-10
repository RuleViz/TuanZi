import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolLoopResumeState } from "../agents/react-tool-agent";
import type { ChatMessage, ToolCall } from "../agents/model-types";
import type { ToolCallRecord, ToolExecutionResult } from "../core/types";
import { assertInsideWorkspace } from "../core/path-utils";

export interface SessionTurnSnapshot {
  id: string;
  userMessage: string;
  assistantMessage: string;
  toolCalls: ToolCallRecord[];
  createdAt: string;
}

export interface UsageSnapshot {
  inputChars: number;
  outputChars: number;
  toolCalls: number;
}

export interface ChatSessionSnapshot {
  version: 1;
  name: string;
  createdAt: string;
  workspaceRoot: string;
  modelOverride: string | null;
  agentOverride: string | null;
  history: SessionTurnSnapshot[];
  usage: UsageSnapshot;
}

export interface ActiveTurnSnapshot {
  version: 1;
  createdAt: string;
  updatedAt: string;
  status: "running" | "interrupted";
  workspaceRoot: string;
  modelOverride: string | null;
  agentOverride: string | null;
  userMessage: string;
  preparedTask: string;
  history: SessionTurnSnapshot[];
  usage: UsageSnapshot;
  resumeState: ToolLoopResumeState | null;
}

export interface SessionListItem {
  name: string;
  createdAt: string;
  path: string;
}

export class ChatSessionStore {
  private readonly checkpointDir: string;
  private readonly runtimeDir: string;

  constructor(private readonly workspaceRoot: string) {
    this.checkpointDir = path.join(this.workspaceRoot, ".tuanzi", "chat-checkpoints");
    this.runtimeDir = path.join(this.workspaceRoot, ".tuanzi", "chat-runtime");
  }

  async save(snapshot: Omit<ChatSessionSnapshot, "version" | "name" | "createdAt">, rawName?: string): Promise<SessionListItem> {
    const name = normalizeSnapshotName(rawName);
    const createdAt = new Date().toISOString();
    const filePath = this.filePathForName(name);

    await fs.mkdir(this.checkpointDir, { recursive: true });
    const fullSnapshot: ChatSessionSnapshot = {
      version: 1,
      name,
      createdAt,
      workspaceRoot: snapshot.workspaceRoot,
      modelOverride: snapshot.modelOverride,
      agentOverride: snapshot.agentOverride,
      history: snapshot.history,
      usage: snapshot.usage
    };
    await fs.writeFile(filePath, `${JSON.stringify(fullSnapshot, null, 2)}\n`, "utf8");

    return {
      name,
      createdAt,
      path: filePath
    };
  }

  async list(): Promise<SessionListItem[]> {
    const entries = await fs.readdir(this.checkpointDir, { withFileTypes: true }).catch(() => []);
    const items: SessionListItem[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(this.checkpointDir, entry.name);
      const snapshot = await this.readSnapshot(filePath).catch(() => null);
      if (!snapshot) {
        continue;
      }
      items.push({
        name: snapshot.name,
        createdAt: snapshot.createdAt,
        path: filePath
      });
    }

    items.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return items;
  }

  async load(rawName: string): Promise<ChatSessionSnapshot> {
    const name = normalizeSnapshotName(rawName);
    const filePath = this.filePathForName(name);
    return this.readSnapshot(filePath);
  }

  async drop(rawName: string): Promise<void> {
    const name = normalizeSnapshotName(rawName);
    const filePath = this.filePathForName(name);
    await fs.unlink(filePath);
  }

  async saveActiveTurn(snapshot: Omit<ActiveTurnSnapshot, "version" | "createdAt" | "updatedAt"> & { createdAt?: string }): Promise<ActiveTurnSnapshot> {
    const filePath = this.activeTurnPath();
    const createdAt = snapshot.createdAt ?? new Date().toISOString();
    const updatedAt = new Date().toISOString();
    const fullSnapshot: ActiveTurnSnapshot = {
      version: 1,
      createdAt,
      updatedAt,
      status: snapshot.status,
      workspaceRoot: snapshot.workspaceRoot,
      modelOverride: snapshot.modelOverride,
      agentOverride: snapshot.agentOverride,
      userMessage: snapshot.userMessage,
      preparedTask: snapshot.preparedTask,
      history: snapshot.history,
      usage: snapshot.usage,
      resumeState: snapshot.resumeState
    };

    await fs.mkdir(this.runtimeDir, { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(fullSnapshot, null, 2)}\n`, "utf8");
    return fullSnapshot;
  }

  async loadActiveTurn(): Promise<ActiveTurnSnapshot | null> {
    const filePath = this.activeTurnPath();
    return this.readActiveTurnSnapshot(filePath).catch(() => null);
  }

  async clearActiveTurn(): Promise<void> {
    const filePath = this.activeTurnPath();
    await fs.unlink(filePath).catch(() => undefined);
  }

  private filePathForName(name: string): string {
    const filename = `${name}.json`;
    const filePath = path.join(this.checkpointDir, filename);
    assertInsideWorkspace(filePath, this.workspaceRoot);
    return filePath;
  }

  private activeTurnPath(): string {
    const filePath = path.join(this.runtimeDir, "active-turn.json");
    assertInsideWorkspace(filePath, this.workspaceRoot);
    return filePath;
  }

  private async readSnapshot(filePath: string): Promise<ChatSessionSnapshot> {
    assertInsideWorkspace(filePath, this.workspaceRoot);
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    const snapshot = parseSnapshot(parsed);
    if (!snapshot) {
      throw new Error(`Invalid checkpoint file: ${filePath}`);
    }
    return snapshot;
  }

  private async readActiveTurnSnapshot(filePath: string): Promise<ActiveTurnSnapshot> {
    assertInsideWorkspace(filePath, this.workspaceRoot);
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    const snapshot = parseActiveTurnSnapshot(parsed);
    if (!snapshot) {
      throw new Error(`Invalid active turn file: ${filePath}`);
    }
    return snapshot;
  }
}

function parseSnapshot(value: unknown): ChatSessionSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return null;
  }
  if (typeof record.name !== "string" || !record.name) {
    return null;
  }
  if (typeof record.createdAt !== "string" || !record.createdAt) {
    return null;
  }
  if (typeof record.workspaceRoot !== "string" || !record.workspaceRoot) {
    return null;
  }
  if (record.modelOverride !== null && typeof record.modelOverride !== "string") {
    return null;
  }
  if (record.agentOverride !== undefined && record.agentOverride !== null && typeof record.agentOverride !== "string") {
    return null;
  }
  if (!Array.isArray(record.history)) {
    return null;
  }
  if (!record.usage || typeof record.usage !== "object" || Array.isArray(record.usage)) {
    return null;
  }

  const usage = parseUsage(record.usage);
  if (!usage) {
    return null;
  }
  const history = record.history
    .map((item) => parseTurn(item))
    .filter((item): item is SessionTurnSnapshot => item !== null);

  return {
    version: 1,
    name: record.name,
    createdAt: record.createdAt,
    workspaceRoot: record.workspaceRoot,
    modelOverride: record.modelOverride ?? null,
    agentOverride: record.agentOverride ?? null,
    history,
    usage
  };
}

function parseActiveTurnSnapshot(value: unknown): ActiveTurnSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return null;
  }
  if (record.status !== "running" && record.status !== "interrupted") {
    return null;
  }
  if (typeof record.createdAt !== "string" || !record.createdAt) {
    return null;
  }
  if (typeof record.updatedAt !== "string" || !record.updatedAt) {
    return null;
  }
  if (typeof record.workspaceRoot !== "string" || !record.workspaceRoot) {
    return null;
  }
  if (record.modelOverride !== null && typeof record.modelOverride !== "string") {
    return null;
  }
  if (record.agentOverride !== undefined && record.agentOverride !== null && typeof record.agentOverride !== "string") {
    return null;
  }
  if (typeof record.userMessage !== "string") {
    return null;
  }
  if (typeof record.preparedTask !== "string") {
    return null;
  }
  if (!Array.isArray(record.history)) {
    return null;
  }
  if (!record.usage || typeof record.usage !== "object" || Array.isArray(record.usage)) {
    return null;
  }

  const usage = parseUsage(record.usage);
  if (!usage) {
    return null;
  }
  const history = record.history
    .map((item) => parseTurn(item))
    .filter((item): item is SessionTurnSnapshot => item !== null);
  const resumeState = record.resumeState === null || record.resumeState === undefined ? null : parseResumeState(record.resumeState);
  if (record.resumeState !== null && record.resumeState !== undefined && !resumeState) {
    return null;
  }

  return {
    version: 1,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
    workspaceRoot: record.workspaceRoot,
    modelOverride: record.modelOverride ?? null,
    agentOverride: record.agentOverride ?? null,
    userMessage: record.userMessage,
    preparedTask: record.preparedTask,
    history,
    usage,
    resumeState
  };
}

function parseUsage(value: unknown): UsageSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    inputChars: toNonNegativeInt(record.inputChars),
    outputChars: toNonNegativeInt(record.outputChars),
    toolCalls: toNonNegativeInt(record.toolCalls)
  };
}

function parseTurn(value: unknown): SessionTurnSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const userMessage = typeof record.userMessage === "string" ? record.userMessage : "";
  const assistantMessage = typeof record.assistantMessage === "string" ? record.assistantMessage : "";
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : "";
  const toolCalls = Array.isArray(record.toolCalls) ? (record.toolCalls as ToolCallRecord[]) : [];
  if (!id || !createdAt) {
    return null;
  }
  return {
    id,
    userMessage,
    assistantMessage,
    toolCalls,
    createdAt
  };
}

function parseResumeState(value: unknown): ToolLoopResumeState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return null;
  }
  if (!Array.isArray(record.messages) || !Array.isArray(record.toolCalls) || !Array.isArray(record.allowedTools)) {
    return null;
  }
  const messages = record.messages.map((item) => parseChatMessage(item)).filter((item): item is ChatMessage => item !== null);
  const toolCalls = record.toolCalls
    .map((item) => parseResumeToolCall(item))
    .filter((item): item is ToolLoopResumeState["toolCalls"][number] => item !== null);
  const allowedTools = record.allowedTools.filter((item): item is string => typeof item === "string");
  const partialAssistantMessage =
    record.partialAssistantMessage === null || record.partialAssistantMessage === undefined
      ? null
      : parseChatMessage(record.partialAssistantMessage);
  if (messages.length !== record.messages.length || toolCalls.length !== record.toolCalls.length || allowedTools.length !== record.allowedTools.length) {
    return null;
  }
  if (record.partialAssistantMessage !== null && record.partialAssistantMessage !== undefined && !partialAssistantMessage) {
    return null;
  }
  return {
    version: 1,
    messages,
    toolCalls,
    allowedTools,
    temperature: typeof record.temperature === "number" && Number.isFinite(record.temperature) ? record.temperature : 0.2,
    maxTurns: Math.max(1, toNonNegativeInt(record.maxTurns)),
    nextTurn: toNonNegativeInt(record.nextTurn),
    partialAssistantMessage
  };
}

function parseChatMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.role !== "system" && record.role !== "user" && record.role !== "assistant" && record.role !== "tool") {
    return null;
  }
  if (typeof record.content !== "string") {
    return null;
  }
  let toolCalls: ToolCall[] | undefined;
  if (record.tool_calls !== undefined) {
    if (!Array.isArray(record.tool_calls)) {
      return null;
    }
    toolCalls = record.tool_calls.map((item) => parseToolCall(item)).filter((item): item is ToolCall => item !== null);
    if (toolCalls.length !== record.tool_calls.length) {
      return null;
    }
  }
  if (record.name !== undefined && typeof record.name !== "string") {
    return null;
  }
  if (record.tool_call_id !== undefined && typeof record.tool_call_id !== "string") {
    return null;
  }
  if (record.reasoning_content !== undefined && typeof record.reasoning_content !== "string") {
    return null;
  }
  return {
    role: record.role,
    content: record.content,
    name: record.name,
    tool_call_id: record.tool_call_id,
    reasoning_content: record.reasoning_content,
    tool_calls: toolCalls
  };
}

function parseToolCall(value: unknown): ToolCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.type !== "function") {
    return null;
  }
  if (!record.function || typeof record.function !== "object" || Array.isArray(record.function)) {
    return null;
  }
  const fn = record.function as Record<string, unknown>;
  if (typeof fn.name !== "string" || typeof fn.arguments !== "string") {
    return null;
  }
  return {
    id: record.id,
    type: "function",
    function: {
      name: fn.name,
      arguments: fn.arguments
    }
  };
}

function parseResumeToolCall(value: unknown): ToolLoopResumeState["toolCalls"][number] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string") {
    return null;
  }
  const args = record.args && typeof record.args === "object" && !Array.isArray(record.args) ? record.args as Record<string, unknown> : null;
  const result = parseToolExecutionResult(record.result);
  if (!args || !result) {
    return null;
  }
  return {
    name: record.name,
    args,
    result
  };
}

function parseToolExecutionResult(value: unknown): ToolExecutionResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.ok !== "boolean") {
    return null;
  }
  if (record.error !== undefined && typeof record.error !== "string") {
    return null;
  }
  return {
    ok: record.ok,
    data: record.data,
    error: record.error
  };
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeSnapshotName(rawName?: string): string {
  const fallback = `session-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const input = (rawName ?? "").trim() || fallback;
  const normalized = input.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || fallback;
}
