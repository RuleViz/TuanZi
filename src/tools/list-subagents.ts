import type {
  JsonObject,
  SubagentSnapshot,
  SubagentStatus,
  Tool,
  ToolExecutionContext,
  ToolExecutionResult
} from "../core/types";
import { asString } from "../core/json-utils";

export class ListSubagentsTool implements Tool {
  readonly definition = {
    name: "list_subagents",
    description: "List current spawned subagents and their latest statuses for this parent task.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["queued", "running", "completed", "failed", "cancelled"],
          description: "Optional status filter."
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

    const status = normalizeStatus(input.status);
    if (input.status !== undefined && !status) {
      return { ok: false, error: "status must be queued, running, completed, failed, or cancelled." };
    }

    return {
      ok: true,
      data: {
        subagents: (await bridge.list(status ?? undefined)).map((snapshot) => toModelFacingSnapshot(snapshot))
      }
    };
  }
}

function normalizeStatus(value: unknown): SubagentStatus | null {
  const text = asString(value);
  if (
    text === "queued" ||
    text === "running" ||
    text === "completed" ||
    text === "failed" ||
    text === "cancelled"
  ) {
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
