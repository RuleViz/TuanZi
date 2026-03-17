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
    const rawTurnsSinceCompaction = await this.store.listTurns(input.workspace, input.sessionId, {
      afterSeq: state.lastCompactedSeq
    });

    const contextText = [
      "[Current Time]",
      new Date().toISOString(),
      "",
      "[Conversation Summary]",
      summary ? formatSummary(summary) : "(none)",
      "",
      "[Turns Since Last Compaction]",
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
            const resultSummary = call.result.ok
              ? summarizeText(JSON.stringify(call.result.data ?? ""), 200)
              : summarizeText(call.result.error ?? "unknown error", 200);
            return `- ${call.toolName}(${summarizeText(JSON.stringify(call.args), 180)}) => ${resultSummary}`;
          })
          .join("\n")
      : "(none)";

  return [
    `Turn #${turn.seq}${turn.interrupted ? " [INTERRUPTED]" : ""}`,
    `User: ${turn.user || "(empty)"}`,
    `Assistant: ${turn.assistant || "(empty)"}`,
    turn.thinkingSummary ? `Thinking: ${summarizeText(turn.thinkingSummary, 800)}` : "Thinking: (none)",
    "Tool Calls:",
    toolCallsSummary
  ].join("\n");
}

function summarizeText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, maxChars)}...(truncated)`;
}
