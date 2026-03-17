import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ConversationSessionState,
  ConversationTurnRecord,
  MemoryCardRecord
} from "./conversation-memory-types";

const SESSION_STATE_FILE = "session-state.json";
const TURNS_FILE = "turns.jsonl";
const MEMORY_CARDS_FILE = "memory-cards.jsonl";

interface SessionPaths {
  dir: string;
  stateFile: string;
  turnsFile: string;
  cardsFile: string;
  workspaceHash: string;
}

export interface ListTurnsOptions {
  afterSeq?: number;
}

export class ConversationMemoryStore {
  private readonly rootDir: string;
  private readonly defaultMemoryCardCacheLimit: number;

  constructor(baseDir: string, options?: { memoryCardCacheLimit?: number }) {
    this.rootDir = join(baseDir, "conversation-memory");
    this.defaultMemoryCardCacheLimit =
      typeof options?.memoryCardCacheLimit === "number" && Number.isFinite(options.memoryCardCacheLimit)
        ? Math.max(1, Math.floor(options.memoryCardCacheLimit))
        : 10;
  }

  getSessionState(workspace: string, sessionId: string): Promise<ConversationSessionState> {
    const paths = this.resolveSessionPaths(workspace, sessionId);
    return this.loadOrCreateSessionState(paths, workspace, sessionId);
  }

  async saveSessionState(state: ConversationSessionState): Promise<void> {
    const paths = this.resolveSessionPaths(state.workspace, state.sessionId);
    await mkdir(paths.dir, { recursive: true });
    const serialized = JSON.stringify(state, null, 2);
    await writeFile(paths.stateFile, `${serialized}\n`, "utf8");
  }

  async appendTurn(record: ConversationTurnRecord): Promise<void> {
    const paths = this.resolveSessionPaths(record.workspace, record.sessionId);
    await mkdir(paths.dir, { recursive: true });
    await appendFile(paths.turnsFile, `${JSON.stringify(record)}\n`, "utf8");
  }

  async listTurns(workspace: string, sessionId: string, options?: ListTurnsOptions): Promise<ConversationTurnRecord[]> {
    const paths = this.resolveSessionPaths(workspace, sessionId);
    const turns = await this.readJsonl<ConversationTurnRecord>(paths.turnsFile, isConversationTurnRecord);
    const afterSeq =
      typeof options?.afterSeq === "number" && Number.isFinite(options.afterSeq)
        ? Math.floor(options.afterSeq)
        : null;
    if (afterSeq === null) {
      return turns;
    }
    return turns.filter((turn) => turn.seq > afterSeq);
  }

  async appendMemoryCard(card: MemoryCardRecord): Promise<void> {
    const paths = this.resolveSessionPaths(card.workspace, card.sessionId);
    await mkdir(paths.dir, { recursive: true });
    await appendFile(paths.cardsFile, `${JSON.stringify(card)}\n`, "utf8");
  }

  listMemoryCards(workspace: string, sessionId: string): Promise<MemoryCardRecord[]> {
    const paths = this.resolveSessionPaths(workspace, sessionId);
    return this.readJsonl<MemoryCardRecord>(paths.cardsFile, isMemoryCardRecord);
  }

  async pruneMemoryCards(workspace: string, sessionId: string, keep: number): Promise<void> {
    const normalizedKeep = Number.isFinite(keep) ? Math.max(1, Math.floor(keep)) : 10;
    const paths = this.resolveSessionPaths(workspace, sessionId);
    await mkdir(paths.dir, { recursive: true });
    const cards = await this.readJsonl<MemoryCardRecord>(paths.cardsFile, isMemoryCardRecord);
    if (cards.length <= normalizedKeep) {
      return;
    }
    const keptCards = cards.slice(cards.length - normalizedKeep);
    const body = keptCards.map((card) => JSON.stringify(card)).join("\n");
    await writeFile(paths.cardsFile, `${body}\n`, "utf8");
  }

  async getLatestMemoryCard(workspace: string, sessionId: string): Promise<MemoryCardRecord | null> {
    const state = await this.getSessionState(workspace, sessionId);
    if (!state.latestCardId) {
      return null;
    }
    const cards = await this.listMemoryCards(workspace, sessionId);
    return cards.find((card) => card.id === state.latestCardId) ?? null;
  }

  resolveWorkspaceHash(workspace: string): string {
    return hashWorkspacePath(workspace);
  }

  private resolveSessionPaths(workspace: string, sessionId: string): SessionPaths {
    const workspaceHash = hashWorkspacePath(workspace);
    const normalizedSessionId = normalizeSessionId(sessionId);
    const dir = join(this.rootDir, workspaceHash, normalizedSessionId);
    return {
      dir,
      stateFile: join(dir, SESSION_STATE_FILE),
      turnsFile: join(dir, TURNS_FILE),
      cardsFile: join(dir, MEMORY_CARDS_FILE),
      workspaceHash
    };
  }

  private async loadOrCreateSessionState(
    paths: SessionPaths,
    workspace: string,
    sessionId: string
  ): Promise<ConversationSessionState> {
    if (existsSync(paths.stateFile)) {
      try {
        const raw = readFileSync(paths.stateFile, "utf8").replace(/^\uFEFF/, "").trim();
        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          if (isConversationSessionState(parsed)) {
            return parsed;
          }
        }
      } catch {
        // Fall through and regenerate a valid default state.
      }
    }

    const now = new Date().toISOString();
    const state: ConversationSessionState = {
      version: 1,
      workspace,
      workspaceHash: paths.workspaceHash,
      sessionId,
      nextSeq: 1,
      latestCardId: null,
      lastCompactedSeq: 0,
      memoryCardCacheLimit: this.defaultMemoryCardCacheLimit,
      modelSnapshot: null,
      createdAt: now,
      updatedAt: now
    };
    await this.saveSessionState(state);
    return state;
  }

  private async readJsonl<T>(filePath: string, guard: (value: unknown) => value is T): Promise<T[]> {
    try {
      const raw = await readFile(filePath, "utf8");
      const lines = raw.split(/\r?\n/);
      const output: T[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (guard(parsed)) {
            output.push(parsed);
          }
        } catch {
          // Skip malformed lines and keep available history readable.
        }
      }
      return output;
    } catch {
      return [];
    }
  }
}

export function hashWorkspacePath(workspace: string): string {
  const normalized = workspace.trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function normalizeSessionId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "default-session";
  }
  return trimmed
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "default-session";
}

function isConversationSessionState(value: unknown): value is ConversationSessionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.workspace === "string" &&
    typeof record.workspaceHash === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.nextSeq === "number" &&
    (record.latestCardId === null || typeof record.latestCardId === "string") &&
    typeof record.lastCompactedSeq === "number" &&
    typeof record.memoryCardCacheLimit === "number" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

function isConversationTurnRecord(value: unknown): value is ConversationTurnRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.workspace === "string" &&
    typeof record.workspaceHash === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.seq === "number" &&
    typeof record.turnId === "string" &&
    typeof record.taskId === "string" &&
    typeof record.turnIndex === "number" &&
    typeof record.user === "string" &&
    typeof record.assistant === "string" &&
    typeof record.thinkingSummary === "string" &&
    Array.isArray(record.toolCalls) &&
    (record.checkpointId === null || typeof record.checkpointId === "string") &&
    typeof record.interrupted === "boolean" &&
    typeof record.createdAt === "string"
  );
}

function isMemoryCardRecord(value: unknown): value is MemoryCardRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.id === "string" &&
    typeof record.workspace === "string" &&
    typeof record.workspaceHash === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.fromSeq === "number" &&
    typeof record.toSeq === "number" &&
    typeof record.title === "string" &&
    typeof record.summary === "string" &&
    Array.isArray(record.keyPoints) &&
    Array.isArray(record.openQuestions) &&
    typeof record.createdAt === "string" &&
    (record.source === "model" || record.source === "fallback")
  );
}
