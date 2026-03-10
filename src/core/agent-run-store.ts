import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolLoopResumeState } from "../agents/react-tool-agent";
import type { ToolCallRecord } from "./types";
import { assertInsideWorkspace } from "./path-utils";

export interface AgentRunSnapshot {
  version: 1;
  createdAt: string;
  updatedAt: string;
  status: "running" | "interrupted";
  workspaceRoot: string;
  modelOverride: string | null;
  agentOverride: string | null;
  task: string;
  preparedTask: string;
  streamedResponse: string;
  toolCalls: ToolCallRecord[];
  resumeState: ToolLoopResumeState | null;
}

export class AgentRunStore {
  private readonly runtimeDir: string;

  constructor(private readonly workspaceRoot: string) {
    this.runtimeDir = path.join(this.workspaceRoot, ".tuanzi", "agent-run");
  }

  async saveActiveRun(
    snapshot: Omit<AgentRunSnapshot, "version" | "createdAt" | "updatedAt"> & { createdAt?: string }
  ): Promise<AgentRunSnapshot> {
    const filePath = this.activeRunPath();
    const createdAt = snapshot.createdAt ?? new Date().toISOString();
    const updatedAt = new Date().toISOString();
    const fullSnapshot: AgentRunSnapshot = {
      version: 1,
      createdAt,
      updatedAt,
      status: snapshot.status,
      workspaceRoot: snapshot.workspaceRoot,
      modelOverride: snapshot.modelOverride,
      agentOverride: snapshot.agentOverride,
      task: snapshot.task,
      preparedTask: snapshot.preparedTask,
      streamedResponse: snapshot.streamedResponse,
      toolCalls: snapshot.toolCalls,
      resumeState: snapshot.resumeState
    };

    await fs.mkdir(this.runtimeDir, { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(fullSnapshot, null, 2)}\n`, "utf8");
    return fullSnapshot;
  }

  async loadActiveRun(): Promise<AgentRunSnapshot | null> {
    const filePath = this.activeRunPath();
    return this.readSnapshot(filePath).catch(() => null);
  }

  async clearActiveRun(): Promise<void> {
    const filePath = this.activeRunPath();
    await fs.unlink(filePath).catch(() => undefined);
  }

  private activeRunPath(): string {
    const filePath = path.join(this.runtimeDir, "active-run.json");
    assertInsideWorkspace(filePath, this.workspaceRoot);
    return filePath;
  }

  private async readSnapshot(filePath: string): Promise<AgentRunSnapshot> {
    assertInsideWorkspace(filePath, this.workspaceRoot);
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    const snapshot = parseAgentRunSnapshot(parsed);
    if (!snapshot) {
      throw new Error(`Invalid agent run snapshot: ${filePath}`);
    }
    return snapshot;
  }
}

function parseAgentRunSnapshot(value: unknown): AgentRunSnapshot | null {
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
  if (record.modelOverride !== null && record.modelOverride !== undefined && typeof record.modelOverride !== "string") {
    return null;
  }
  if (record.agentOverride !== null && record.agentOverride !== undefined && typeof record.agentOverride !== "string") {
    return null;
  }
  if (typeof record.task !== "string") {
    return null;
  }
  if (typeof record.preparedTask !== "string") {
    return null;
  }
  if (typeof record.streamedResponse !== "string") {
    return null;
  }
  if (!Array.isArray(record.toolCalls)) {
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
    task: record.task,
    preparedTask: record.preparedTask,
    streamedResponse: record.streamedResponse,
    toolCalls: record.toolCalls as ToolCallRecord[],
    resumeState: (record.resumeState as ToolLoopResumeState | null | undefined) ?? null
  };
}
