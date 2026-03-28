import type { ChatCompletionClient, ChatMessage, ChatMessageContent } from "./model-types";

export interface CompactionAgentInput {
  messages: ChatMessage[];
  maxRetries: number;
}

export interface CompactionAgentResult {
  ok: boolean;
  summary?: string;
  error?: string;
  attempts: number;
}

export class CompactionAgent {
  constructor(
    private readonly client: ChatCompletionClient,
    private readonly model: string,
    private readonly logger: {
      info(message: string): void;
      warn(message: string): void;
    }
  ) {}

  async compact(input: CompactionAgentInput): Promise<CompactionAgentResult> {
    const maxRetries = normalizeMaxRetries(input.maxRetries);
    const transcript = formatConversationTranscript(input.messages);
    const prompt = buildCompactionPrompt(transcript);
    let lastError = "Compaction summary is empty.";

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        const completion = await this.client.complete({
          model: this.model,
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content: "You create high-fidelity context compaction summaries for ongoing coding tasks."
            },
            {
              role: "user",
              content: prompt
            }
          ]
        });
        const summary = messageContentToText(completion.message.content).trim();
        if (!summary) {
          lastError = "Compaction summary is empty.";
          this.logger.warn(`[compaction] attempt=${attempt}/${maxRetries} failed: ${lastError}`);
          continue;
        }
        this.logger.info(`[compaction] attempt=${attempt}/${maxRetries} succeeded`);
        return {
          ok: true,
          summary,
          attempts: attempt
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[compaction] attempt=${attempt}/${maxRetries} failed: ${lastError}`);
      }
    }

    return {
      ok: false,
      error: lastError,
      attempts: maxRetries
    };
  }
}

function normalizeMaxRetries(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 5;
  }
  return Math.floor(value);
}

function buildCompactionPrompt(transcript: string): string {
  return [
    "Your task is to create a detailed summary of the conversation so far.",
    "This summary will be the ONLY context available when the conversation continues.",
    "",
    "Preserve critical information including:",
    "1. What was accomplished (completed tasks, files changed)",
    "2. Current work in progress (what step we're on)",
    "3. Files involved (paths and their current state)",
    "4. Next steps (clear actions to take)",
    "5. Key user requests, constraints, or preferences",
    "6. Important technical decisions and why they were made",
    "7. Errors encountered and how they were resolved",
    "",
    "Be concise but detailed enough that work can continue seamlessly.",
    "",
    "[Conversation Transcript]",
    transcript
  ].join("\n");
}

function formatConversationTranscript(messages: ChatMessage[]): string {
  if (messages.length === 0) {
    return "(no messages)";
  }
  const lines: string[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    lines.push(`[${index + 1}] role=${message.role}${message.isMeta ? " isMeta=true" : ""}`);
    if (message.name) {
      lines.push(`name: ${message.name}`);
    }
    if (message.tool_call_id) {
      lines.push(`tool_call_id: ${message.tool_call_id}`);
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      lines.push(`tool_calls: ${JSON.stringify(message.tool_calls)}`);
    }
    if (message.reasoning_content) {
      lines.push(`reasoning: ${message.reasoning_content}`);
    }
    lines.push(`content: ${messageContentToText(message.content) || "(empty)"}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function messageContentToText(content: ChatMessageContent): string {
  if (typeof content === "string") {
    return content;
  }
  const chunks: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      chunks.push(part.text);
      continue;
    }
    if (part.type === "image_url") {
      chunks.push(`[image_url:${part.image_url.url}]`);
    }
  }
  return chunks.join("\n");
}
