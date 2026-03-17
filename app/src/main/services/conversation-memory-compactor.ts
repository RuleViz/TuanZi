import type { ProviderModelProtocolType } from "../../shared/domain-types";
import type {
  ConversationSummaryRecord,
  ConversationTurnRecord
} from "./conversation-memory-types";
import { ConversationMemoryStore } from "./conversation-memory-store";

export interface CompactorModelConfig {
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  protocolType: ProviderModelProtocolType;
}

export interface CompactConversationInput {
  workspace: string;
  sessionId: string;
  modelConfig: CompactorModelConfig | null;
}

interface CompactionDraft {
  title: string;
  summary: string;
  keyPoints: string[];
  openQuestions: string[];
  source: "model" | "fallback";
}

export class ConversationMemoryCompactor {
  constructor(
    private readonly store: ConversationMemoryStore,
    private readonly options?: { toErrorMessage?: (error: unknown) => string; log?: (message: string) => void }
  ) {}

  async compactToSummary(input: CompactConversationInput): Promise<ConversationSummaryRecord | null> {
    const state = await this.store.getSessionState(input.workspace, input.sessionId);
    const turns = await this.store.listTurns(input.workspace, input.sessionId, {
      afterSeq: state.lastCompactedSeq
    });
    if (turns.length === 0) {
      return null;
    }

    const previousSummary = await this.store.getSummary(input.workspace, input.sessionId);

    const draft =
      (await this.tryModelCompaction(previousSummary, turns, input.modelConfig).catch((error) => {
        this.log(`compaction model call failed: ${this.toErrorMessage(error)}`);
        return null;
      })) ?? buildFallbackCompaction(previousSummary, turns);

    const fromSeq = previousSummary ? Math.min(previousSummary.fromSeq, turns[0].seq) : turns[0].seq;
    const toSeq = turns[turns.length - 1].seq;
    const updatedAt = new Date().toISOString();

    const summary: ConversationSummaryRecord = {
      version: 1,
      workspace: input.workspace,
      workspaceHash: this.store.resolveWorkspaceHash(input.workspace),
      sessionId: input.sessionId,
      fromSeq,
      toSeq,
      title: sanitizeSingleLine(draft.title) || `Memory ${fromSeq}-${toSeq}`,
      summary: sanitizeParagraph(draft.summary),
      keyPoints: normalizeStringList(draft.keyPoints),
      openQuestions: normalizeStringList(draft.openQuestions),
      updatedAt,
      source: draft.source
    };

    await this.store.saveSummary(summary);
    state.lastCompactedSeq = toSeq;
    state.updatedAt = updatedAt;
    await this.store.saveSessionState(state);
    return summary;
  }

  private async tryModelCompaction(
    previousSummary: ConversationSummaryRecord | null,
    turns: ConversationTurnRecord[],
    modelConfig: CompactorModelConfig | null
  ): Promise<CompactionDraft | null> {
    if (!modelConfig) {
      return null;
    }
    if (modelConfig.protocolType !== "openai_chat_completions") {
      return null;
    }
    const baseUrl = normalizeOptionalString(modelConfig.baseUrl);
    const apiKey = normalizeOptionalString(modelConfig.apiKey);
    const model = normalizeOptionalString(modelConfig.model);
    if (!baseUrl || !apiKey || !model) {
      return null;
    }

    const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const prompt = buildCompactionPrompt(previousSummary, turns);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-DashScope-Api-Key": apiKey
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        stream: false,
        max_tokens: 900,
        messages: [
          {
            role: "system",
            content:
              "You compress conversation memory summary. Return strict JSON only with keys: title, summary, keyPoints, openQuestions. Keep tool outputs abstracted as concise summaries."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`compaction request failed: ${response.status} ${response.statusText} ${body}`.trim());
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      return null;
    }

    const parsed = tryParseCompactionDraft(content);
    if (!parsed) {
      return null;
    }
    return {
      ...parsed,
      source: "model"
    };
  }

  private toErrorMessage(error: unknown): string {
    if (this.options?.toErrorMessage) {
      return this.options.toErrorMessage(error);
    }
    return error instanceof Error ? error.message : String(error);
  }

  private log(message: string): void {
    this.options?.log?.(message);
  }
}

function tryParseCompactionDraft(content: string): Omit<CompactionDraft, "source"> | null {
  const parsed = parseJsonObject(content);
  if (!parsed) {
    return null;
  }
  const title = normalizeOptionalString(parsed.title) ?? "";
  const summary = normalizeOptionalString(parsed.summary) ?? "";
  const keyPoints = normalizeStringList(parsed.keyPoints);
  const openQuestions = normalizeStringList(parsed.openQuestions);
  return {
    title,
    summary,
    keyPoints,
    openQuestions
  };
}

function parseJsonObject(input: string): Record<string, unknown> | null {
  const text = input.trim();
  if (!text) {
    return null;
  }
  const candidates = [text, extractFirstJsonObject(text)].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

function extractFirstJsonObject(input: string): string | null {
  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return input.slice(start, end + 1);
}

function buildCompactionPrompt(previousSummary: ConversationSummaryRecord | null, turns: ConversationTurnRecord[]): string {
  const previousSummarySection = previousSummary
    ? [
        `Title: ${previousSummary.title}`,
        `Summary: ${previousSummary.summary}`,
        `Key Points: ${previousSummary.keyPoints.join(" | ") || "(none)"}`,
        `Open Questions: ${previousSummary.openQuestions.join(" | ") || "(none)"}`
      ].join("\n")
    : "(none)";

  const turnsSection = turns.map((turn) => formatTurnForCompaction(turn)).join("\n\n");

  return [
    "Please merge previous long-term conversation summary and new turns into one updated summary.",
    "Do NOT include raw tool outputs; only abstracted outcomes.",
    "Return strict JSON with keys: title, summary, keyPoints, openQuestions.",
    "",
    "[Previous Summary]",
    previousSummarySection,
    "",
    "[New Turns Since Last Compaction]",
    turnsSection
  ].join("\n");
}

function formatTurnForCompaction(turn: ConversationTurnRecord): string {
  const toolSummary =
    turn.toolCalls.length > 0
      ? turn.toolCalls
          .map((call) => {
            const resultText = call.result.ok
              ? summarizeText(JSON.stringify(call.result.data ?? ""), 160)
              : summarizeText(call.result.error ?? "unknown error", 160);
            return `${call.toolName}: ${resultText}`;
          })
          .join(" | ")
      : "none";

  return [
    `Turn #${turn.seq}${turn.interrupted ? " [interrupted]" : ""}`,
    `User: ${summarizeText(turn.user, 800)}`,
    `Assistant: ${summarizeText(turn.assistant, 1000)}`,
    `Thinking Summary: ${summarizeText(turn.thinkingSummary, 500) || "(none)"}`,
    `Tool Outcome Summary: ${toolSummary}`
  ].join("\n");
}

function buildFallbackCompaction(
  previousSummary: ConversationSummaryRecord | null,
  turns: ConversationTurnRecord[]
): CompactionDraft {
  const userIntents = turns
    .map((turn) => summarizeText(sanitizeSingleLine(turn.user), 120))
    .filter((item) => item.length > 0)
    .slice(-8);
  const assistantOutcomes = turns
    .map((turn) => summarizeText(sanitizeSingleLine(turn.assistant), 140))
    .filter((item) => item.length > 0)
    .slice(-8);
  const keyPoints = dedupeStrings([
    ...(previousSummary?.keyPoints ?? []),
    ...userIntents.map((item) => `User asked: ${item}`),
    ...assistantOutcomes.map((item) => `Assistant response: ${item}`)
  ]).slice(-12);
  const openQuestions = turns
    .filter((turn) => turn.interrupted)
    .map((turn) => `Interrupted turn #${turn.seq}: ${summarizeText(sanitizeSingleLine(turn.user), 120)}`)
    .slice(-5);

  return {
    title: previousSummary?.title || `Memory ${turns[0].seq}-${turns[turns.length - 1].seq}`,
    summary: [
      previousSummary?.summary ?? "",
      `Merged ${turns.length} new turns (${turns[0].seq}-${turns[turns.length - 1].seq}).`
    ]
      .filter((item) => item.trim().length > 0)
      .join(" "),
    keyPoints,
    openQuestions,
    source: "fallback"
  };
}

function normalizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") {
      continue;
    }
    const normalized = sanitizeSingleLine(item);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function dedupeStrings(values: string[]): string[] {
  return normalizeStringList(values);
}

function sanitizeSingleLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function sanitizeParagraph(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

function summarizeText(input: string, maxChars: number): string {
  const normalized = input.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...(truncated)`;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
