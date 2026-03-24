import type {
  ConversationSummaryRecord,
  ConversationTurnRecord
} from "./conversation-memory-types";
import { ConversationMemoryStore } from "./conversation-memory-store";

export interface AssembleConversationContextInput {
  workspace: string;
  sessionId: string;
  currentUserMessage: string;
}

export interface AssembleConversationContextOutput {
  contextText: string;
  summary: ConversationSummaryRecord | null;
  rawTurnsSinceCompaction: ConversationTurnRecord[];
}

export class ConversationMemoryAssembler {
  constructor(private readonly store: ConversationMemoryStore) {}

  async assembleContext(input: AssembleConversationContextInput): Promise<AssembleConversationContextOutput> {
    const state = await this.store.getSessionState(input.workspace, input.sessionId);
    const summary = await this.store.getSummary(input.workspace, input.sessionId);
    const rawTurnsSinceCompaction = await this.store.listTurns(input.workspace, input.sessionId);

    const contextText = [
      "[Current Time]",
      new Date().toISOString(),
      "",
      "[Conversation Summary]",
      summary ? formatSummary(summary) : "(none)",
      "",
      `[All Raw Turns${state.lastCompactedSeq > 0 ? ` | last compacted seq=${state.lastCompactedSeq}` : ""}]`,
      rawTurnsSinceCompaction.length > 0
        ? rawTurnsSinceCompaction.map((turn) => formatTurn(turn)).join("\n\n")
        : "(none)",
      "",
      "[Current User Input]",
      input.currentUserMessage || "(empty)"
    ].join("\n");

    return {
      contextText,
      summary,
      rawTurnsSinceCompaction
    };
  }
}

function formatSummary(summary: ConversationSummaryRecord): string {
  const keyPoints =
    summary.keyPoints.length > 0 ? summary.keyPoints.map((point) => `- ${point}`).join("\n") : "- (none)";
  const openQuestions =
    summary.openQuestions.length > 0
      ? summary.openQuestions.map((item) => `- ${item}`).join("\n")
      : "- (none)";

  return [
    `range: ${summary.fromSeq} -> ${summary.toSeq}`,
    `title: ${summary.title || "(untitled)"}`,
    `updated_at: ${summary.updatedAt}`,
    "summary:",
    summary.summary || "(empty)",
    "key_points:",
    keyPoints,
    "open_questions:",
    openQuestions
  ].join("\n");
}

function formatTurn(turn: ConversationTurnRecord): string {
  const toolCallsSummary =
    turn.toolCalls.length > 0
      ? turn.toolCalls
          .map((call) => {
            return [
              `- ${call.toolName}`,
              "  args:",
              indentBlock(serializeValue(call.args)),
              "  result:",
              indentBlock(
                call.result.ok
                  ? serializeValue(call.result.data ?? null)
                  : serializeValue({ ok: false, error: call.result.error ?? "unknown error" })
              )
            ].join("\n");
          })
          .join("\n")
      : "(none)";

  const errorTag = turn.error ? " [ERROR]" : "";
  const interruptedTag = turn.interrupted ? " [INTERRUPTED]" : "";

  const parts = [
    `Turn #${turn.seq}${interruptedTag}${errorTag}`,
    `User: ${turn.user || "(empty)"}`,
    `Assistant: ${turn.assistant || "(empty)"}`,
    turn.thinkingSummary ? `Thinking:\n${indentBlock(turn.thinkingSummary)}` : "Thinking: (none)",
    "Tool Calls:",
    toolCallsSummary
  ];

  if (turn.error) {
    parts.push(`Error: ${turn.error}`);
  }

  return parts.join("\n");
}

function serializeValue(value: unknown): string {
  if (typeof value === "string") {
    return value || "(empty)";
  }
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized ?? "null";
  } catch {
    return "[unserializable]";
  }
}

function indentBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}
