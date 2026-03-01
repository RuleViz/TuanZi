import type { ChatCompletionClient, ChatCompletionResult, ChatMessage } from "./model-types";

export interface OpenAICompatibleClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export class OpenAICompatibleClient implements ChatCompletionClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenAICompatibleClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async complete(input: {
    model: string;
    messages: ChatMessage[];
    tools?: Array<{
      type: "function";
      function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      };
    }>;
    temperature?: number;
  }): Promise<ChatCompletionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`
        },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          tools: input.tools,
          temperature: input.temperature ?? 0.2
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Model request failed: ${response.status} ${response.statusText} ${errorText}`.trim());
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: ChatMessage }>;
      };
      const message = payload.choices?.[0]?.message;
      if (!message) {
        throw new Error("Model response did not include message content.");
      }
      return { message };
    } finally {
      clearTimeout(timeout);
    }
  }
}
