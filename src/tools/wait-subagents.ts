import type {
  JsonObject,
  SubagentSnapshot,
  Tool,
  ToolExecutionContext,
  ToolExecutionResult
} from "../core/types";
import { asNumber, asString, asStringArray } from "../core/json-utils";

export class WaitSubagentsTool implements Tool {
  readonly definition = {
    name: "wait_subagents",
    description: "Wait for one or more spawned subagents to reach a terminal state.",
    parameters: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional subagent ids. Omit to wait on all subagents for the current task."
        },
        waitMode: {
          type: "string",
          enum: ["all", "any"],
          description: "Wait for all targeted subagents or return when any one finishes."
        },
        timeoutMs: {
          type: "number",
          description: "Optional timeout in milliseconds."
        }
      },
      required: [],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const bridge = context.subagentBridge;
    if (!bridge) {
      return { ok: false, error: "Subagent bridge is not available in the current runtime." };
    }

    const ids = asStringArray(input.ids) ?? undefined;
    const waitMode = normalizeWaitMode(input.waitMode);
    if (input.waitMode !== undefined && !waitMode) {
      return { ok: false, error: "waitMode must be either 'all' or 'any'." };
    }

    const timeoutMs = asNumber(input.timeoutMs) ?? undefined;
    const result = await bridge.wait({
      ...(ids ? { ids } : {}),
      ...(waitMode ? { waitMode } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {})
    });
    return {
      ok: true,
      data: {
        completed: result.completed.map((snapshot) => toModelFacingSnapshot(snapshot)),
        pending: result.pending.map((snapshot) => toPendingSnapshot(snapshot)),
        timedOut: result.timedOut
      }
    };
  }
}

function normalizeWaitMode(value: unknown): "all" | "any" | null {
  const text = asString(value);
  if (text === "all" || text === "any") {
    return text;
  }
  return null;
}

function toModelFacingSnapshot(snapshot: SubagentSnapshot): {
  subagentId: string;
  parentTaskId: string | null;
  kind: string;
  task: string;
  context: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  summary: string;
  fullText: string;
  references: Array<{ path: string; reason: string; confidence: "low" | "medium" | "high" }>;
  webReferences: Array<{ url: string; reason: string }>;
  toolCalls: Array<{
    id: string;
    name: string;
    args: JsonObject;
    result: ToolExecutionResult;
  }>;
  error: string | null;
} {
  return {
    subagentId: snapshot.id,
    parentTaskId: snapshot.parentTaskId,
    kind: snapshot.kind,
    task: snapshot.task,
    context: snapshot.context,
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    summary: snapshot.result?.summary ?? "",
    fullText: snapshot.result?.fullText ?? "",
    references: snapshot.result?.references ?? [],
    webReferences: snapshot.result?.webReferences ?? [],
    toolCalls: snapshot.result?.toolCalls ? cloneJson(snapshot.result.toolCalls) : [],
    error: snapshot.result?.error ?? null
  };
}

function toPendingSnapshot(snapshot: SubagentSnapshot): {
  subagentId: string;
  task: string;
  status: string;
} {
  return {
    subagentId: snapshot.id,
    task: snapshot.task,
    status: snapshot.status
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
