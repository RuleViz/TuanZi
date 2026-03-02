import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolCallRecord } from "../core/types";
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
  history: SessionTurnSnapshot[];
  usage: UsageSnapshot;
}

export interface SessionListItem {
  name: string;
  createdAt: string;
  path: string;
}

export class ChatSessionStore {
  private readonly checkpointDir: string;

  constructor(private readonly workspaceRoot: string) {
    this.checkpointDir = path.join(this.workspaceRoot, ".mycoderagent", "chat-checkpoints");
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

  private filePathForName(name: string): string {
    const filename = `${name}.json`;
    const filePath = path.join(this.checkpointDir, filename);
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
  if (!Array.isArray(record.history)) {
    return null;
  }
  if (!record.usage || typeof record.usage !== "object" || Array.isArray(record.usage)) {
    return null;
  }

  const usageRecord = record.usage as Record<string, unknown>;
  const usage: UsageSnapshot = {
    inputChars: toNonNegativeInt(usageRecord.inputChars),
    outputChars: toNonNegativeInt(usageRecord.outputChars),
    toolCalls: toNonNegativeInt(usageRecord.toolCalls)
  };
  const history = record.history
    .map((item) => parseTurn(item))
    .filter((item): item is SessionTurnSnapshot => item !== null);

  return {
    version: 1,
    name: record.name,
    createdAt: record.createdAt,
    workspaceRoot: record.workspaceRoot,
    modelOverride: record.modelOverride ?? null,
    history,
    usage
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
