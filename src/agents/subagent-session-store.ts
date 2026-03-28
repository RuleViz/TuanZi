import { promises as fs } from "node:fs";
import path from "node:path";
import { assertInsideWorkspace } from "../core/path-utils";

export interface StoredSubagentSessionSnapshot {
  version: 1;
  sessionId: string;
  agentId: string;
  task: string;
  context: string;
  createdAt: string;
  updatedAt: string;
  conversationSnapshot: {
    messages: unknown[];
    resumeState: unknown;
  };
}

export class SubagentSessionStore {
  private readonly rootDir: string;

  constructor(private readonly workspaceRoot: string) {
    this.rootDir = path.join(this.workspaceRoot, ".tuanzi", "subagent-snapshots");
  }

  async save(input: {
    sessionId: string;
    agentId: string;
    task: string;
    context: string;
    conversationSnapshot: {
      messages: unknown[];
      resumeState: unknown;
    };
  }): Promise<StoredSubagentSessionSnapshot> {
    const sessionId = normalizeRequiredText(input.sessionId, "sessionId");
    const agentId = normalizeRequiredText(input.agentId, "agentId");
    const createdAt = (await this.loadOptional({ sessionId, agentId }))?.createdAt ?? new Date().toISOString();
    const snapshot: StoredSubagentSessionSnapshot = {
      version: 1,
      sessionId,
      agentId,
      task: input.task,
      context: input.context,
      createdAt,
      updatedAt: new Date().toISOString(),
      conversationSnapshot: {
        messages: cloneJson(input.conversationSnapshot.messages),
        resumeState: cloneJson(input.conversationSnapshot.resumeState)
      }
    };

    const filePath = this.snapshotPath(sessionId, agentId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    return snapshot;
  }

  async load(input: { sessionId: string; agentId: string }): Promise<StoredSubagentSessionSnapshot> {
    const sessionId = normalizeRequiredText(input.sessionId, "sessionId");
    const agentId = normalizeRequiredText(input.agentId, "agentId");
    const filePath = this.snapshotPath(sessionId, agentId);
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const snapshot = parseStoredSnapshot(parsed);
    if (!snapshot) {
      throw new Error(`Invalid subagent snapshot: ${filePath}`);
    }
    return snapshot;
  }

  private async loadOptional(input: { sessionId: string; agentId: string }): Promise<StoredSubagentSessionSnapshot | null> {
    try {
      return await this.load(input);
    } catch {
      return null;
    }
  }

  private snapshotPath(sessionId: string, agentId: string): string {
    const filePath = path.join(this.rootDir, sessionId, `${agentId}.json`);
    assertInsideWorkspace(filePath, this.workspaceRoot);
    return filePath;
  }
}

function parseStoredSnapshot(value: unknown): StoredSubagentSessionSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return null;
  }
  if (typeof record.sessionId !== "string" || !record.sessionId.trim()) {
    return null;
  }
  if (typeof record.agentId !== "string" || !record.agentId.trim()) {
    return null;
  }
  if (typeof record.task !== "string") {
    return null;
  }
  if (typeof record.context !== "string") {
    return null;
  }
  if (typeof record.createdAt !== "string" || !record.createdAt) {
    return null;
  }
  if (typeof record.updatedAt !== "string" || !record.updatedAt) {
    return null;
  }
  const conversationSnapshot =
    record.conversationSnapshot &&
    typeof record.conversationSnapshot === "object" &&
    !Array.isArray(record.conversationSnapshot)
      ? (record.conversationSnapshot as Record<string, unknown>)
      : null;
  if (!conversationSnapshot || !Array.isArray(conversationSnapshot.messages) || conversationSnapshot.resumeState === undefined) {
    return null;
  }
  return {
    version: 1,
    sessionId: record.sessionId,
    agentId: record.agentId,
    task: record.task,
    context: record.context,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    conversationSnapshot: {
      messages: cloneJson(conversationSnapshot.messages),
      resumeState: cloneJson(conversationSnapshot.resumeState)
    }
  };
}

function normalizeRequiredText(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} is required.`);
  }
  return value.trim();
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
