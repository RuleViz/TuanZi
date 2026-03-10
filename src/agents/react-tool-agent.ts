import type { ToolRegistry } from "../core/tool-registry";
import type { JsonObject, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import {
  isInterruptedAssistantMessageError,
  type ChatCompletionClient,
  type ChatMessage,
  type ToolCall
} from "./model-types";

export interface ToolLoopToolCallSnapshot {
  name: string;
  args: JsonObject;
  result: ToolExecutionResult;
}

export interface ToolLoopResumeState {
  version: 1;
  messages: ChatMessage[];
  toolCalls: ToolLoopToolCallSnapshot[];
  allowedTools: string[];
  temperature: number;
  maxTurns: number;
  nextTurn: number;
  partialAssistantMessage: ChatMessage | null;
}

export interface ToolLoopOutput {
  finalText: string;
  toolCalls: ToolLoopToolCallSnapshot[];
  messages: ChatMessage[];
}

export class ReactToolAgent {
  constructor(
    private readonly client: ChatCompletionClient,
    private readonly model: string,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolContext: ToolExecutionContext
  ) { }

  async run(input: {
    systemPrompt: string;
    userPrompt: string;
    allowedTools: string[];
    temperature?: number;
    maxTurns?: number;
    onAssistantTextDelta?: (delta: string) => void;
    onAssistantThinkingDelta?: (delta: string) => void;
    onToolCallCompleted?: (call: ToolLoopToolCallSnapshot) => void;
    onStateChange?: (state: ToolLoopResumeState) => void;
    resumeState?: ToolLoopResumeState | null;
    signal?: AbortSignal;
  }): Promise<ToolLoopOutput> {
    const temperature = input.resumeState?.temperature ?? input.temperature ?? 0.2;
    const maxTurns = input.resumeState?.maxTurns ?? input.maxTurns ?? 12;
    this.toolContext.logger.info(
      `[agent] start tool-loop model=${this.model} allowedTools=${input.allowedTools.length} maxTurns=${maxTurns}`
    );
    const noProgressRepeatTurns = this.toolContext.agentSettings?.toolLoop.noProgressRepeatTurns ?? 2;
    const messages = cloneMessages(
      input.resumeState?.messages ?? [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt }
      ]
    );
    const toolCalls = cloneToolCallSnapshots(input.resumeState?.toolCalls ?? []);
    const toolDefinitions = this.toolRegistry.getToolDefinitions(input.allowedTools);
    const requestTools = toolDefinitions.length > 0 ? toolDefinitions : undefined;
    let previousRequestedCalls: string[] | null = null;
    let repeatedNoProgressTurns = 0;
    let nextTurn = clampTurnIndex(input.resumeState?.nextTurn ?? 0);

    if (hasCarryForwardAssistantText(input.resumeState?.partialAssistantMessage ?? null)) {
      messages.push(stripPartialAssistantMessage(input.resumeState!.partialAssistantMessage!));
      messages.push({
        role: "user",
        content: "Your previous response was interrupted. Continue from where you left off without repeating text. Continue using tools if needed."
      });
    }

    const emitState = (partialAssistantMessage: ChatMessage | null): void => {
      input.onStateChange?.({
        version: 1,
        messages: cloneMessages(messages),
        toolCalls: cloneToolCallSnapshots(toolCalls),
        allowedTools: [...input.allowedTools],
        temperature,
        maxTurns,
        nextTurn,
        partialAssistantMessage: partialAssistantMessage ? cloneMessage(partialAssistantMessage) : null
      });
    };

    emitState(null);

    for (let turn = nextTurn; turn < maxTurns; turn += 1) {
      if (this.toolContext.signal?.aborted) {
        emitState(null);
        throw new Error("Interrupted by user");
      }

      let partialAssistantMessage: ChatMessage | null = null;
      let completion;
      try {
        completion = await this.client.complete({
          model: this.model,
          messages,
          tools: requestTools,
          temperature,
          requestOptions: this.toolContext.agentSettings?.modelRequest ? {
            reasoningEffort: this.toolContext.agentSettings.modelRequest.reasoningEffort ?? undefined,
            thinking: this.toolContext.agentSettings.modelRequest.thinking.type ? {
              type: this.toolContext.agentSettings.modelRequest.thinking.type as "enabled" | "disabled",
              budget_tokens: this.toolContext.agentSettings.modelRequest.thinking.budgetTokens ?? undefined
            } : undefined,
            extraBody: this.toolContext.agentSettings.modelRequest.extraBody
          } : undefined
        }, {
          onContentDelta: (delta) => {
            if (!delta) {
              return;
            }
            partialAssistantMessage = appendAssistantText(partialAssistantMessage, delta);
            emitState(partialAssistantMessage);
            input.onAssistantTextDelta?.(delta);
          },
          onThinkingDelta: (delta) => {
            if (!delta) {
              return;
            }
            partialAssistantMessage = appendAssistantThinking(partialAssistantMessage, delta);
            emitState(partialAssistantMessage);
            input.onAssistantThinkingDelta?.(delta);
          },
          signal: input.signal
        });
      } catch (error) {
        if (isInterruptedAssistantMessageError(error)) {
          emitState(error.partialMessage);
        } else {
          emitState(partialAssistantMessage);
        }
        throw error;
      }

      const assistantMessage = completion.message;
      messages.push(cloneMessage(assistantMessage));
      nextTurn = turn + 1;
      emitState(null);

      const calls = assistantMessage.tool_calls ?? [];
      if (calls.length === 0) {
        this.toolContext.logger.info(`[agent] completed without tool calls at turn=${turn + 1}`);
        return {
          finalText: assistantMessage.content ?? "",
          toolCalls,
          messages
        };
      }

      const currentRequestedCalls = calls.map((call) => requestedCallSignature(call));
      if (previousRequestedCalls && arraysEqual(previousRequestedCalls, currentRequestedCalls)) {
        repeatedNoProgressTurns += 1;
      } else {
        repeatedNoProgressTurns = 0;
      }
      previousRequestedCalls = currentRequestedCalls;

      if (repeatedNoProgressTurns >= noProgressRepeatTurns) {
        this.toolContext.logger.warn(
          `[agent] no-progress breaker triggered at turn=${turn + 1} repeatedTurns=${repeatedNoProgressTurns}`
        );
        emitState(null);
        return {
          finalText: "Tool loop stopped due to repeated no-progress tool calls.",
          toolCalls,
          messages
        };
      }

      this.toolContext.logger.info(`[agent] turn=${turn + 1} toolCalls=${calls.length}`);
      for (const call of calls) {
        if (this.toolContext.signal?.aborted) {
          emitState(null);
          throw new Error("Interrupted by user");
        }
        const toolResponse = await this.invokeTool(call, input.allowedTools);
        const toolCallSnapshot: ToolLoopToolCallSnapshot = {
          name: call.function.name,
          args: toolResponse.args,
          result: toolResponse.result
        };
        toolCalls.push(toolCallSnapshot);
        input.onToolCallCompleted?.(cloneToolCallSnapshot(toolCallSnapshot));
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(toolResponse.result)
        });
        emitState(null);
      }
    }

    emitState(null);
    return {
      finalText: "Tool loop reached max turns without final assistant output.",
      toolCalls,
      messages
    };
  }

  private async invokeTool(
    call: ToolCall,
    allowedTools: string[]
  ): Promise<{ args: JsonObject; result: ToolExecutionResult }> {
    if (!allowedTools.includes(call.function.name)) {
      return {
        args: {},
        result: {
          ok: false,
          error: `Tool ${call.function.name} is not allowed for this agent.`
        }
      };
    }

    let args: JsonObject;
    try {
      args = parseToolArgs(call.function.arguments);
    } catch (error) {
      const message = error instanceof ToolArgsParseError ? error.message : `Failed to parse tool arguments: ${String(error)}`;
      this.toolContext.logger.warn(`[tool] invalid args ${call.function.name} error=${message}`);
      return {
        args: {},
        result: {
          ok: false,
          error: message
        }
      };
    }
    this.toolContext.logger.info(`[tool] start ${call.function.name} args=${safePreview(args)}`);
    const result = await this.toolRegistry.execute(call.function.name, args, this.toolContext);
    this.toolContext.logger.info(`[tool] done ${call.function.name} ok=${result.ok}`);
    return { args, result };
  }
}

function appendAssistantText(message: ChatMessage | null, delta: string): ChatMessage {
  if (message) {
    return {
      ...message,
      content: `${message.content}${delta}`
    };
  }
  return {
    role: "assistant",
    content: delta
  };
}

function appendAssistantThinking(message: ChatMessage | null, delta: string): ChatMessage {
  if (message) {
    return {
      ...message,
      content: message.content,
      reasoning_content: `${message.reasoning_content ?? ""}${delta}`
    };
  }
  return {
    role: "assistant",
    content: "",
    reasoning_content: delta
  };
}

function hasCarryForwardAssistantText(message: ChatMessage | null): boolean {
  if (!message) {
    return false;
  }
  return Boolean(message.content || message.reasoning_content);
}

function stripPartialAssistantMessage(message: ChatMessage): ChatMessage {
  return {
    role: "assistant",
    content: message.content,
    reasoning_content: message.reasoning_content
  };
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => cloneMessage(message));
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    role: message.role,
    content: message.content,
    name: message.name,
    tool_call_id: message.tool_call_id,
    reasoning_content: message.reasoning_content,
    tool_calls: message.tool_calls?.map((call) => ({
      id: call.id,
      type: call.type,
      function: {
        name: call.function.name,
        arguments: call.function.arguments
      }
    }))
  };
}

function cloneToolCallSnapshots(toolCalls: ToolLoopToolCallSnapshot[]): ToolLoopToolCallSnapshot[] {
  return toolCalls.map((call) => cloneToolCallSnapshot(call));
}

function cloneToolCallSnapshot(call: ToolLoopToolCallSnapshot): ToolLoopToolCallSnapshot {
  return {
    name: call.name,
    args: cloneJsonObject(call.args),
    result: cloneToolExecutionResult(call.result)
  };
}

function cloneToolExecutionResult(result: ToolExecutionResult): ToolExecutionResult {
  return {
    ok: result.ok,
    data: cloneJsonLike(result.data),
    error: result.error
  };
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return (cloneJsonLike(value) ?? {}) as JsonObject;
}

function cloneJsonLike<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function clampTurnIndex(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function parseToolArgs(rawArguments: string): JsonObject {
  if (!rawArguments || rawArguments.trim() === "") {
    return {};
  }
  const trimmed = rawArguments.trim();
  const parsedJson = tryParseObject(trimmed);
  if (parsedJson) {
    return parsedJson;
  }

  const parsedXml = parseTaggedArgs(trimmed);
  if (parsedXml) {
    return parsedXml;
  }

  throw new ToolArgsParseError(
    `Tool argument parsing failed. Expected JSON object or XML-like tags. Raw arguments: ${safeInlineText(rawArguments)}`,
    rawArguments
  );
}

function tryParseObject(text: string): JsonObject | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  } catch {
    // Continue to JSON5 / XML fallback.
  }

  return tryParseLooseJsonObject(text);
}

function parseTaggedArgs(text: string): JsonObject | null {
  const core = extractTagText(text, "tool_call") ?? text;
  const entries = [...core.matchAll(/<([a-zA-Z_][\w-]*)>([\s\S]*?)<\/\1>/g)];
  if (entries.length === 0) {
    return null;
  }

  const result: JsonObject = {};
  for (const [, tag, rawValue] of entries) {
    const key = tag.trim();
    if (key === "tool_call" || key === "name") {
      continue;
    }
    const value = rawValue.replace(/^\s*\n?/, "").replace(/\n?\s*$/, "");
    result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function extractTagText(text: string, tag: string): string | null {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1] : null;
}

function tryParseLooseJsonObject(text: string): JsonObject | null {
  const normalized = text
    .replace(/([{,]\s*)([A-Za-z_][\w-]*)(\s*:)/g, '$1"$2"$3')
    .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ': "$1"')
    .replace(/,\s*([}\]])/g, "$1");
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  } catch {
    return null;
  }
  return null;
}

function safeInlineText(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 500 ? `${singleLine.slice(0, 500)}...` : singleLine;
}

class ToolArgsParseError extends Error {
  constructor(message: string, readonly rawArguments: string) {
    super(message);
    this.name = "ToolArgsParseError";
  }
}

function safePreview(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (!text) {
      return "{}";
    }
    return text.length > 240 ? `${text.slice(0, 240)}...` : text;
  } catch {
    return "[unserializable]";
  }
}

function requestedCallSignature(call: ToolCall): string {
  try {
    const args = parseToolArgs(call.function.arguments);
    return `${call.function.name}:${stableStringify(args)}`;
  } catch {
    return `${call.function.name}:__RAW__${safeInlineText(call.function.arguments)}`;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
