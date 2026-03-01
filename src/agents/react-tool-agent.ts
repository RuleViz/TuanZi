import type { ToolRegistry } from "../core/tool-registry";
import type { JsonObject, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import type { ChatCompletionClient, ChatMessage, ToolCall } from "./model-types";

export interface ToolLoopOutput {
  finalText: string;
  toolCalls: Array<{
    name: string;
    args: JsonObject;
    result: ToolExecutionResult;
  }>;
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
  }): Promise<ToolLoopOutput> {
    const maxTurns = input.maxTurns ?? 12;
    this.toolContext.logger.info(
      `[agent] start tool-loop model=${this.model} allowedTools=${input.allowedTools.length} maxTurns=${maxTurns}`
    );
    const noProgressRepeatTurns = this.toolContext.agentSettings?.toolLoop.noProgressRepeatTurns ?? 2;
    const messages: ChatMessage[] = [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt }
    ];
    const toolCalls: Array<{ name: string; args: JsonObject; result: ToolExecutionResult }> = [];
    const toolDefinitions = this.toolRegistry.getToolDefinitions(input.allowedTools);
    let previousRequestedCalls: string[] | null = null;
    let repeatedNoProgressTurns = 0;

    for (let turn = 0; turn < maxTurns; turn += 1) {
      const completion = await this.client.complete({
        model: this.model,
        messages,
        tools: toolDefinitions,
        temperature: input.temperature ?? 0.2
      });

      const assistantMessage = completion.message;
      messages.push(assistantMessage);

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
        return {
          finalText: "Tool loop stopped due to repeated no-progress tool calls.",
          toolCalls,
          messages
        };
      }

      this.toolContext.logger.info(`[agent] turn=${turn + 1} toolCalls=${calls.length}`);
      for (const call of calls) {
        const toolResponse = await this.invokeTool(call, input.allowedTools);
        toolCalls.push({
          name: call.function.name,
          args: toolResponse.args,
          result: toolResponse.result
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(toolResponse.result)
        });
      }
    }

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

    const args = parseToolArgs(call.function.arguments);
    this.toolContext.logger.info(`[tool] start ${call.function.name} args=${safePreview(args)}`);
    const result = await this.toolRegistry.execute(call.function.name, args, this.toolContext);
    this.toolContext.logger.info(`[tool] done ${call.function.name} ok=${result.ok}`);
    return { args, result };
  }
}

function parseToolArgs(rawArguments: string): JsonObject {
  if (!rawArguments || rawArguments.trim() === "") {
    return {};
  }
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as JsonObject;
  } catch {
    return {};
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
  const args = parseToolArgs(call.function.arguments);
  return `${call.function.name}:${stableStringify(args)}`;
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
