export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionResult {
  message: ChatMessage;
}

export interface ChatCompletionOptions {
  onContentDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface ChatCompletionThinkingConfig {
  type: "enabled" | "disabled";
  budget_tokens?: number;
}

export interface ChatCompletionRequestOptions {
  reasoningEffort?: "low" | "medium" | "high";
  thinking?: ChatCompletionThinkingConfig;
  extraBody?: Record<string, unknown>;
}

export interface ChatCompletionClient {
  complete(input: {
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
  }, options?: ChatCompletionOptions): Promise<ChatCompletionResult>;
}

export class InterruptedAssistantMessageError extends Error {
  constructor(
    message: string,
    readonly partialMessage: ChatMessage
  ) {
    super(message);
    this.name = "InterruptedAssistantMessageError";
  }
}

export function isInterruptedAssistantMessageError(error: unknown): error is InterruptedAssistantMessageError {
  return error instanceof InterruptedAssistantMessageError;
}
