export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
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
  }, options?: ChatCompletionOptions): Promise<ChatCompletionResult>;
}
