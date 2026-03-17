import type {
  ConversationTurnRecord,
  MemoryCardRecord
} from "./conversation-memory-types";
import { ConversationMemoryStore } from "./conversation-memory-store";

export interface AssembleConversationContextInput {
  workspace: string;
  sessionId: string;
  currentUserMessage: string;
}

export interface AssembleConversationContextOutput {
  contextText: string;
  latestCard: MemoryCardRecord | null;
  rawTurnsSinceCard: ConversationTurnRecord[];
}

export class ConversationMemoryAssembler {
  constructor(private readonly store: ConversationMemoryStore) {}

  async assembleContext(input: AssembleConversationContextInput): Promise<AssembleConversationContextOutput> {
    const state = await this.store.getSessionState(input.workspace, input.sessionId);
    const cards = await this.store.listMemoryCards(input.workspace, input.sessionId);
    const latestCard = state.latestCardId
      ? cards.find((card) => card.id === state.latestCardId) ?? null
      : null;
    const rawTurnsSinceCard = await this.store.listTurns(input.workspace, input.sessionId, {
      afterSeq: state.lastCompactedSeq
    });

    const contextText = [
      "[Current Time]",
      new Date().toISOString(),
      "",
      "[Latest Memory Card]",
      latestCard ? formatMemoryCard(latestCard) : "(none)",
      "",
      "[Turns Since Last Card]",
      rawTurnsSinceCard.length > 0
        ? rawTurnsSinceCard.map((turn) => formatTurn(turn)).join("\n\n")
        : "(none)",
      "",
      "[Current User Input]",
      input.currentUserMessage || "(empty)"
    ].join("\n");

    return {
      contextText,
      latestCard,
      rawTurnsSinceCard
    };
  }
}

function formatMemoryCard(card: MemoryCardRecord): string {
  const keyPoints = card.keyPoints.length > 0 ? card.keyPoints.map((point) => `- ${point}`).join("\n") : "- (none)";
  const openQuestions =
    card.openQuestions.length > 0 ? card.openQuestions.map((item) => `- ${item}`).join("\n") : "- (none)";

  return [
    `id: ${card.id}`,
    `range: ${card.fromSeq} -> ${card.toSeq}`,
    `title: ${card.title || "(untitled)"}`,
    "summary:",
    card.summary || "(empty)",
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
