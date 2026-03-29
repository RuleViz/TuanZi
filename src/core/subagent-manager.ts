import type {
  SubagentBridge,
  SubagentResultSummary,
  SubagentSnapshot,
  SubagentStatus,
  SubagentTaskKind
} from "./types";

export interface SubagentStreamDelta {
  type: "thinking" | "text" | "tool_start" | "tool_end";
  subagentId: string;
  delta?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: { ok: boolean; data?: unknown; error?: string };
}

export interface SubagentStreamCallbacks {
  onThinkingDelta?: (delta: string) => void;
  onTextDelta?: (delta: string) => void;
  onToolStart?: (toolCallId: string, toolName: string, args: Record<string, unknown>) => void;
  onToolEnd?: (toolCallId: string, toolName: string, result: { ok: boolean; data?: unknown; error?: string }) => void;
}

interface SubagentManagerOptions {
  maxConcurrent: number;
  taskId?: string | null;
  runExplorer: (input: {
    id: string;
    task: string;
    context: string;
    signal: AbortSignal;
    resumeFromSnapshotId?: string;
    streamCallbacks?: SubagentStreamCallbacks;
  }) => Promise<SubagentResultSummary>;
  onSnapshotsChange?: (snapshots: SubagentSnapshot[]) => void;
  onStreamDelta?: (delta: SubagentStreamDelta) => void;
}

interface SubagentEntry {
  snapshot: SubagentSnapshot;
  controller: AbortController | null;
  resumeFromSnapshotId?: string;
}

export class SubagentManager implements SubagentBridge {
  private readonly maxConcurrent: number;
  private readonly entries = new Map<string, SubagentEntry>();
  private readonly queue: string[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly parentTaskId: string | null;
  private activeCount = 0;
  private nextId = 1;
  private disposed = false;

  constructor(private readonly options: SubagentManagerOptions) {
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent));
    this.parentTaskId = normalizeOptionalText(options.taskId ?? null);
  }

  async spawn(input: {
    task: string;
    context?: string;
    agentType?: SubagentTaskKind;
  }): Promise<{ subagentId: string; status: SubagentStatus }> {
    return this.enqueue({
      id: `subagent-${this.nextId++}`,
      task: input.task,
      context: input.context,
      agentType: input.agentType
    });
  }

  async resume(input: {
    snapshotId: string;
    task: string;
    context?: string;
    agentType?: SubagentTaskKind;
  }): Promise<{ subagentId: string; status: SubagentStatus }> {
    const snapshotId = normalizeRequiredText(input.snapshotId, "snapshotId");
    return this.enqueue({
      id: snapshotId,
      task: input.task,
      context: input.context,
      agentType: input.agentType,
      resumeFromSnapshotId: snapshotId
    });
  }

  private async enqueue(input: {
    id: string;
    task: string;
    context?: string;
    agentType?: SubagentTaskKind;
    resumeFromSnapshotId?: string;
  }): Promise<{ subagentId: string; status: SubagentStatus }> {
    const task = normalizeRequiredText(input.task, "task");
    const kind = input.agentType ?? "explorer";
    if (kind !== "explorer") {
      throw new Error(`Unsupported subagent type: ${kind}`);
    }
    if (this.disposed) {
      throw new Error("Subagent manager is already disposed.");
    }

    const now = new Date().toISOString();
    this.entries.set(input.id, {
      controller: null,
      ...(input.resumeFromSnapshotId ? { resumeFromSnapshotId: input.resumeFromSnapshotId } : {}),
      snapshot: {
        id: input.id,
        parentTaskId: this.parentTaskId,
        kind,
        status: "queued",
        task,
        context: normalizeOptionalText(input.context) ?? "",
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
        result: null
      }
    });
    this.queue.push(input.id);
    this.emitSnapshots();
    this.pumpQueue();
    return {
      subagentId: input.id,
      status: "queued"
    };
  }

  async wait(input?: {
    ids?: string[];
    waitMode?: "all" | "any";
    timeoutMs?: number;
  }): Promise<{
    completed: SubagentSnapshot[];
    pending: SubagentSnapshot[];
    timedOut: boolean;
  }> {
    const targetIds = resolveTargetIds(this.entries, input?.ids);
    const waitMode = input?.waitMode === "any" ? "any" : "all";
    const timeoutMs = clampTimeout(input?.timeoutMs);
    const startedAt = Date.now();

    while (true) {
      const state = this.collectWaitState(targetIds);
      if (isWaitSatisfied(state, waitMode)) {
        return {
          completed: state.completed,
          pending: state.pending,
          timedOut: false
        };
      }

      const elapsed = Date.now() - startedAt;
      if (timeoutMs !== null && elapsed >= timeoutMs) {
        return {
          completed: state.completed,
          pending: state.pending,
          timedOut: true
        };
      }

      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | null = null;
        const onChange = (): void => {
          if (timer) {
            clearTimeout(timer);
          }
          this.waiters.delete(onChange);
          resolve();
        };
        this.waiters.add(onChange);

        if (timeoutMs !== null) {
          const remaining = Math.max(1, timeoutMs - elapsed);
          timer = setTimeout(() => {
            this.waiters.delete(onChange);
            resolve();
          }, remaining);
        }
      });
    }
  }

  async list(status?: SubagentStatus): Promise<SubagentSnapshot[]> {
    const snapshots = [...this.entries.values()].map((entry) => cloneSnapshot(entry.snapshot));
    if (!status) {
      return snapshots;
    }
    return snapshots.filter((snapshot) => snapshot.status === status);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      if (entry.snapshot.status === "queued") {
        this.markCancelled(entry, "Cancelled before execution.");
      } else if (entry.snapshot.status === "running") {
        entry.controller?.abort();
      }
    }
    this.emitSnapshots();
  }

  private pumpQueue(): void {
    while (!this.disposed && this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) {
        break;
      }
      const entry = this.entries.get(id);
      if (!entry || entry.snapshot.status !== "queued") {
        continue;
      }
      this.startEntry(entry);
    }
  }

  private startEntry(entry: SubagentEntry): void {
    this.activeCount += 1;
    entry.controller = new AbortController();
    const startedAt = new Date().toISOString();
    entry.snapshot.status = "running";
    entry.snapshot.startedAt = startedAt;
    entry.snapshot.updatedAt = startedAt;
    this.emitSnapshots();

    const subagentId = entry.snapshot.id;
    const streamCallbacks: SubagentStreamCallbacks | undefined = this.options.onStreamDelta ? {
      onThinkingDelta: (delta) => {
        this.options.onStreamDelta?.({ type: "thinking", subagentId, delta });
      },
      onTextDelta: (delta) => {
        this.options.onStreamDelta?.({ type: "text", subagentId, delta });
      },
      onToolStart: (toolCallId, toolName, args) => {
        this.options.onStreamDelta?.({ type: "tool_start", subagentId, toolCallId, toolName, args });
      },
      onToolEnd: (toolCallId, toolName, result) => {
        this.options.onStreamDelta?.({ type: "tool_end", subagentId, toolCallId, toolName, result });
      }
    } : undefined;

    void this.options
      .runExplorer({
        id: entry.snapshot.id,
        task: entry.snapshot.task,
        context: entry.snapshot.context,
        signal: entry.controller.signal,
        ...(entry.resumeFromSnapshotId ? { resumeFromSnapshotId: entry.resumeFromSnapshotId } : {}),
        streamCallbacks
      })
      .then((result) => {
        const completedAt = result.data.metadata.completedAt;
        entry.snapshot.status = toSnapshotStatus(result.exitReason);
        entry.snapshot.completedAt = completedAt;
        entry.snapshot.updatedAt = completedAt;
        entry.snapshot.result = cloneResult(result);
      })
      .catch((error) => {
        if (entry.controller?.signal.aborted || this.disposed) {
          this.markCancelled(entry, error instanceof Error ? error.message : "Cancelled.");
          return;
        }
        const completedAt = new Date().toISOString();
        entry.snapshot.status = "failed";
        entry.snapshot.completedAt = completedAt;
        entry.snapshot.updatedAt = completedAt;
        entry.snapshot.result = buildFailedResult(error instanceof Error ? error.message : String(error), completedAt);
      })
      .finally(() => {
        this.activeCount = Math.max(0, this.activeCount - 1);
        entry.controller = null;
        this.emitSnapshots();
        this.pumpQueue();
      });
  }

  private markCancelled(entry: SubagentEntry, message: string): void {
    const completedAt = new Date().toISOString();
    entry.snapshot.status = "cancelled";
    entry.snapshot.completedAt = completedAt;
    entry.snapshot.updatedAt = completedAt;
    entry.snapshot.result = {
      ...buildFailedResult(message, completedAt),
      exitReason: "interrupted"
    };
  }

  private collectWaitState(targetIds: string[]): {
    completed: SubagentSnapshot[];
    pending: SubagentSnapshot[];
  } {
    const completed: SubagentSnapshot[] = [];
    const pending: SubagentSnapshot[] = [];
    for (const id of targetIds) {
      const snapshot = this.entries.get(id)?.snapshot;
      if (!snapshot) {
        continue;
      }
      if (isTerminalStatus(snapshot.status)) {
        completed.push(cloneSnapshot(snapshot));
      } else {
        pending.push(cloneSnapshot(snapshot));
      }
    }
    return { completed, pending };
  }

  private emitSnapshots(): void {
    const snapshots = [...this.entries.values()].map((entry) => cloneSnapshot(entry.snapshot));
    this.options.onSnapshotsChange?.(snapshots);
    for (const waiter of [...this.waiters]) {
      waiter();
    }
  }
}

function resolveTargetIds(entries: Map<string, SubagentEntry>, ids?: string[]): string[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    return [...entries.keys()];
  }
  const uniqueIds: string[] = [];
  const seen = new Set<string>();
  for (const value of ids) {
    const normalized = normalizeOptionalText(value);
    if (!normalized || seen.has(normalized) || !entries.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    uniqueIds.push(normalized);
  }
  return uniqueIds;
}

function isWaitSatisfied(
  state: { completed: SubagentSnapshot[]; pending: SubagentSnapshot[] },
  waitMode: "all" | "any"
): boolean {
  if (waitMode === "any") {
    return state.completed.length > 0 || state.pending.length === 0;
  }
  return state.pending.length === 0;
}

function normalizeRequiredText(value: unknown, fieldName: string): string {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }
  return normalized;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clampTimeout(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(1, Math.floor(value));
}

function isTerminalStatus(status: SubagentStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function toSnapshotStatus(exitReason: SubagentResultSummary["exitReason"]): SubagentStatus {
  if (exitReason === "interrupted") {
    return "cancelled";
  }
  if (exitReason === "error" || exitReason === "max_turns" || exitReason === "no_progress") {
    return "failed";
  }
  return "completed";
}

function buildFailedResult(message: string, completedAt: string): SubagentResultSummary {
  return {
    data: {
      summary: message,
      references: [],
      webReferences: [],
      fullTextPreview: message,
      toolCallPreview: [],
      metadata: {
        toolCalls: [],
        turnCount: 0,
        completedAt,
        error: message
      }
    },
    exitReason: "error",
    error: message,
    context: {
      messages: [],
      toolCalls: []
    }
  };
}

function cloneSnapshot(snapshot: SubagentSnapshot): SubagentSnapshot {
  return {
    ...snapshot,
    result: snapshot.result ? cloneResult(snapshot.result) : null
  };
}

function cloneResult(result: SubagentResultSummary): SubagentResultSummary {
  return JSON.parse(JSON.stringify(result)) as SubagentResultSummary;
}
