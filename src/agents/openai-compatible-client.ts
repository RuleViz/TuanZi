import type {
  ChatCompletionClient,
  ChatCompletionOptions,
  ChatCompletionRequestOptions,
  ChatCompletionResult,
  ChatMessage,
  ToolCall
} from "./model-types";

export interface OpenAICompatibleClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  defaultRequestOptions?: ChatCompletionRequestOptions;
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
    requestOptions?: ChatCompletionRequestOptions;
  }, options?: ChatCompletionOptions): Promise<ChatCompletionResult> {
    const normalizedInput = {
      ...input,
      requestOptions: mergeRequestOptions(this.options.defaultRequestOptions, input.requestOptions)
    };
    if (options?.onContentDelta) {
      try {
        return await this.completeWithStream(normalizedInput, options);
      } catch {
        // Fallback to non-stream mode when stream endpoint is unavailable.
      }
    }
    return this.completeWithoutStream(normalizedInput);
  }

  private async completeWithoutStream(input: {
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
    requestOptions?: ChatCompletionRequestOptions;
  }): Promise<ChatCompletionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(buildChatCompletionsPayload(input, false)),
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

  private async completeWithStream(
    input: {
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
      requestOptions?: ChatCompletionRequestOptions;
    },
    options: ChatCompletionOptions
  ): Promise<ChatCompletionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(buildChatCompletionsPayload(input, true)),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Model request failed: ${response.status} ${response.statusText} ${errorText}`.trim());
      }
      if (!response.body) {
        throw new Error("Model stream response has no body.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const message: ChatMessage = {
        role: "assistant",
        content: ""
      };
      const toolCallsByIndex = new Map<number, ToolCall>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) {
            continue;
          }
          const payloadText = trimmed.slice(5).trim();
          if (!payloadText) {
            continue;
          }
          if (payloadText === "[DONE]") {
            break;
          }

          const chunk = parseJsonChunk(payloadText);
          if (!chunk) {
            continue;
          }
          applyStreamChunk(chunk, message, toolCallsByIndex, options.onContentDelta, options.onThinkingDelta);
        }
      }

      if (toolCallsByIndex.size > 0) {
        message.tool_calls = [...toolCallsByIndex.entries()]
          .sort((left, right) => left[0] - right[0])
          .map((entry) => entry[1]);
      }
      return { message };
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.options.apiKey}`,
      "X-DashScope-Api-Key": this.options.apiKey
    };
  }
}

function parseJsonChunk(text: string): StreamChunk | null {
  try {
    return JSON.parse(text) as StreamChunk;
  } catch {
    return null;
  }
}

function applyStreamChunk(
  chunk: StreamChunk,
  message: ChatMessage,
  toolCallsByIndex: Map<number, ToolCall>,
  onContentDelta?: (delta: string) => void,
  onThinkingDelta?: (delta: string) => void
): void {
  const delta = chunk.choices?.[0]?.delta;
  if (!delta) {
    return;
  }

  if (delta.role === "assistant") {
    message.role = "assistant";
  }

  if (typeof delta.content === "string" && delta.content.length > 0) {
    message.content = `${message.content}${delta.content}`;
    onContentDelta?.(delta.content);
  }

  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
    message.reasoning_content = `${message.reasoning_content ?? ""}${delta.reasoning_content}`;
    onThinkingDelta?.(delta.reasoning_content);
  }

  if (!Array.isArray(delta.tool_calls)) {
    return;
  }
  for (const partial of delta.tool_calls) {
    const index = typeof partial.index === "number" ? partial.index : 0;
    const existing = toolCallsByIndex.get(index) ?? {
      id: partial.id || `call_${index}`,
      type: "function" as const,
      function: {
        name: "",
        arguments: ""
      }
    };

    if (partial.id) {
      existing.id = partial.id;
    }

    if (partial.function) {
      if (typeof partial.function.name === "string") {
        existing.function.name = `${existing.function.name}${partial.function.name}`;
      }
      if (typeof partial.function.arguments === "string") {
        existing.function.arguments = `${existing.function.arguments}${partial.function.arguments}`;
      }
    }

    toolCallsByIndex.set(index, existing);
  }
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      role?: "assistant";
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
}

function buildChatCompletionsPayload(
  input: {
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
    requestOptions?: ChatCompletionRequestOptions;
  },
  stream: boolean
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    tools: input.tools,
    temperature: input.temperature ?? 0.2
  };
  if (stream) {
    payload.stream = true;
  }

  if (input.requestOptions?.reasoningEffort) {
    payload.reasoning_effort = input.requestOptions.reasoningEffort;
  }
  if (input.requestOptions?.thinking) {
    payload.thinking = input.requestOptions.thinking;
  }
  if (input.requestOptions?.extraBody) {
    Object.assign(payload, input.requestOptions.extraBody);
    // Keep core request keys stable even when using provider-specific extension fields.
    payload.model = input.model;
    payload.messages = input.messages;
    payload.tools = input.tools;
    payload.temperature = input.temperature ?? 0.2;
    if (stream) {
      payload.stream = true;
    } else {
      delete payload.stream;
    }
  }

  return payload;
}

function mergeRequestOptions(
  defaults?: ChatCompletionRequestOptions,
  overrides?: ChatCompletionRequestOptions
): ChatCompletionRequestOptions | undefined {
  const reasoningEffort = overrides?.reasoningEffort ?? defaults?.reasoningEffort;
  const thinking = overrides?.thinking ?? defaults?.thinking;
  const extraBody =
    defaults?.extraBody || overrides?.extraBody
      ? {
        ...(defaults?.extraBody ?? {}),
        ...(overrides?.extraBody ?? {})
      }
      : undefined;

  if (!reasoningEffort && !thinking && !extraBody) {
    return undefined;
  }
  return {
    reasoningEffort,
    thinking,
    extraBody
  };
}
