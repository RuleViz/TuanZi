import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ConversationModelSnapshot,
  ConversationSessionState,
  ConversationSummaryRecord,
  ConversationTurnRecord
} from "./conversation-memory-types";

const SESSION_STATE_FILE = "session-state.json";
const TURNS_FILE = "turns.jsonl";
const SUMMARY_FILE = "summary.json";

interface SessionPaths {
  dir: string;
  stateFile: string;
  turnsFile: string;
  summaryFile: string;
  workspaceHash: string;
}

export interface ListTurnsOptions {
  afterSeq?: number;
}

export class ConversationMemoryStore {
  private readonly rootDir: string;

  constructor(baseDir: string) {
    this.rootDir = join(baseDir, "conversation-memory");
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

  async rollbackToCheckpoint(workspace: string, sessionId: string, checkpointId: string): Promise<boolean> {
    const paths = this.resolveSessionPaths(workspace, sessionId);
    const turns = await this.readJsonl<ConversationTurnRecord>(paths.turnsFile, isConversationTurnRecord);
    const targetIndex = turns.findIndex((turn) => turn.checkpointId === checkpointId);
    if (targetIndex < 0) {
      return false;
    }

    const targetTurn = turns[targetIndex];
    const keptTurns = turns.slice(0, targetIndex);
    await mkdir(paths.dir, { recursive: true });
    const serializedTurns = keptTurns.map((turn) => JSON.stringify(turn)).join("\n");
    await writeFile(paths.turnsFile, serializedTurns ? `${serializedTurns}\n` : "", "utf8");

    const state = await this.loadOrCreateSessionState(paths, workspace, sessionId);
    state.nextSeq = targetTurn.seq;
    state.updatedAt = new Date().toISOString();

    const summary = await this.getSummary(workspace, sessionId);
    if (summary && summary.toSeq >= targetTurn.seq) {
      state.lastCompactedSeq = 0;
      await rm(paths.summaryFile, { force: true }).catch(() => undefined);
    }

    await this.saveSessionState(state);
    return true;
  }

  async getSummary(workspace: string, sessionId: string): Promise<ConversationSummaryRecord | null> {
    const paths = this.resolveSessionPaths(workspace, sessionId);
    try {
      const raw = await readFile(paths.summaryFile, "utf8");
      const trimmed = raw.replace(/^\uFEFF/, "").trim();
      if (!trimmed) {
        return null;
      }
      const parsed = JSON.parse(trimmed) as unknown;
      return normalizeSummaryRecord(parsed, {
        workspace,
        workspaceHash: paths.workspaceHash,
        sessionId
      });
    } catch {
      return null;
    }
  }

  async saveSummary(summary: ConversationSummaryRecord): Promise<void> {
    const paths = this.resolveSessionPaths(summary.workspace, summary.sessionId);
    await mkdir(paths.dir, { recursive: true });
    const serialized = JSON.stringify(summary, null, 2);
    await writeFile(paths.summaryFile, `${serialized}\n`, "utf8");
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
      summaryFile: join(dir, SUMMARY_FILE),
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
          const normalized = normalizeSessionState(parsed, {
            workspace,
            workspaceHash: paths.workspaceHash,
            sessionId
          });
          if (normalized) {
            return normalized;
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
      lastCompactedSeq: 0,
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
  return (
    trimmed
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "") || "default-session"
  );
}

function normalizeSessionState(
  value: unknown,
  fallback: { workspace: string; workspaceHash: string; sessionId: string }
): ConversationSessionState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const now = new Date().toISOString();

  return {
    version: 1,
    workspace: normalizeOptionalString(record.workspace) ?? fallback.workspace,
    workspaceHash: normalizeOptionalString(record.workspaceHash) ?? fallback.workspaceHash,
    sessionId: normalizeOptionalString(record.sessionId) ?? fallback.sessionId,
    nextSeq: normalizePositiveInteger(record.nextSeq, 1),
    lastCompactedSeq: normalizeInteger(record.lastCompactedSeq, 0),
    modelSnapshot: normalizeModelSnapshot(record.modelSnapshot),
    createdAt: normalizeOptionalString(record.createdAt) ?? now,
    updatedAt: normalizeOptionalString(record.updatedAt) ?? now
  };
}

function normalizeModelSnapshot(input: unknown): ConversationModelSnapshot | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;

  return {
    providerId: normalizeNullableString(record.providerId),
    providerType: normalizeNullableString(record.providerType),
    modelId: normalizeNullableString(record.modelId),
    contextWindowTokens: normalizeNullablePositiveInt(record.contextWindowTokens),
    maxOutputTokens: normalizeNullablePositiveInt(record.maxOutputTokens),
    protocolType: normalizeProtocolType(record.protocolType),
    tokenEstimatorType: normalizeTokenEstimatorType(record.tokenEstimatorType),
    capturedAt: normalizeOptionalString(record.capturedAt) ?? new Date().toISOString()
  };
}

function normalizeSummaryRecord(
  input: unknown,
  fallback: { workspace: string; workspaceHash: string; sessionId: string }
): ConversationSummaryRecord | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const hasRecognizedField =
    "summary" in record ||
    "title" in record ||
    "keyPoints" in record ||
    "openQuestions" in record ||
    "toSeq" in record;
  if (!hasRecognizedField) {
    return null;
  }
  const updatedAt =
    normalizeOptionalString(record.updatedAt) ?? normalizeOptionalString(record.createdAt) ?? new Date().toISOString();
  const fromSeq = normalizePositiveInteger(record.fromSeq, 1);
  const toSeq = Math.max(fromSeq, normalizeInteger(record.toSeq, fromSeq));

  return {
    version: 1,
    workspace: normalizeOptionalString(record.workspace) ?? fallback.workspace,
    workspaceHash: normalizeOptionalString(record.workspaceHash) ?? fallback.workspaceHash,
    sessionId: normalizeOptionalString(record.sessionId) ?? fallback.sessionId,
    fromSeq,
    toSeq,
    title: normalizeOptionalString(record.title) ?? "",
    summary: normalizeOptionalString(record.summary) ?? "",
    keyPoints: normalizeStringArray(record.keyPoints),
    openQuestions: normalizeStringArray(record.openQuestions),
    updatedAt,
    source: record.source === "model" ? "model" : "fallback"
  };
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

function normalizeNullableString(input: unknown): string | null {
  return input === null ? null : normalizeOptionalString(input);
}

function normalizeOptionalString(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const trimmed = input.trim();
  return trimmed ? trimmed : null;
}

function normalizeInteger(input: unknown, fallback: number): number {
  if (typeof input === "number" && Number.isFinite(input)) {
    return Math.max(0, Math.floor(input));
  }
  if (typeof input === "string") {
    const parsed = Number(input.trim());
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor(parsed));
    }
  }
  return fallback;
}

function normalizePositiveInteger(input: unknown, fallback: number): number {
  const normalized = normalizeInteger(input, fallback);
  return normalized > 0 ? normalized : fallback;
}

function normalizeNullablePositiveInt(input: unknown): number | null {
  if (input === null || input === undefined) {
    return null;
  }
  const normalized = normalizeInteger(input, 0);
  return normalized > 0 ? normalized : null;
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const text = normalizeOptionalString(item);
    if (!text) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(text);
  }
  return output;
}

function normalizeProtocolType(
  input: unknown
): "openai_chat_completions" | "openai_responses" | "anthropic_messages" | "gemini_generate_content" | "custom" {
  if (input === "openai_responses") {
    return input;
  }
  if (input === "anthropic_messages") {
    return input;
  }
  if (input === "gemini_generate_content") {
    return input;
  }
  if (input === "custom") {
    return input;
  }
  return "openai_chat_completions";
}

function normalizeTokenEstimatorType(input: unknown): "builtin" | "remote_exact" | "heuristic" {
  if (input === "remote_exact") {
    return input;
  }
  if (input === "heuristic") {
    return input;
  }
  return "builtin";
}
