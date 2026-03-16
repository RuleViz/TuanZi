import assert from "node:assert/strict";
import { test } from "node:test";
import { ReactToolAgent } from "../agents/react-tool-agent";
import type { ChatCompletionClient, ChatCompletionResult, ChatMessage } from "../agents/model-types";
import { ToolRegistry } from "../core/tool-registry";
import type { JsonObject, ModelFunctionToolDefinition, ToolExecutionContext } from "../core/types";

class SequenceClient implements ChatCompletionClient {
  private index = 0;
  capturedTools: ModelFunctionToolDefinition[] | undefined;

  constructor(private readonly sequence: ChatMessage[]) {}

  async complete(input: {
    model: string;
    messages: ChatMessage[];
    tools?: ModelFunctionToolDefinition[];
  }): Promise<ChatCompletionResult> {
    if (!this.capturedTools) {
      this.capturedTools = input.tools;
    }
    const message = this.sequence[this.index] ?? {
      role: "assistant",
      content: "done"
    };
    this.index += 1;
    return { message };
  }
}

test("ReactToolAgent should dispatch MCP tool calls via mcpBridge", async () => {
  const mcpCalls: Array<{ name: string; args: JsonObject }> = [];
  const context: ToolExecutionContext = {
    workspaceRoot: process.cwd(),
    approvalGate: {
      async approve() {
        return { approved: true };
      }
    },
    backupManager: {
      async backupFile() {
        return null;
      }
    },
    logger: {
      info() {
        return;
      },
      warn() {
        return;
      },
      error() {
        return;
      }
    },
    mcpBridge: {
      async callTool(name, args) {
        mcpCalls.push({ name, args });
        return {
          content: [{ type: "text", text: "ok" }]
        };
      }
    }
  };

  const additionalTool: ModelFunctionToolDefinition = {
    type: "function",
    function: {
      name: "mcp__demo__echo",
      description: "Echo text through MCP.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" }
        },
        required: ["text"],
        additionalProperties: false
      }
    }
  };

  const client = new SequenceClient([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "mcp__demo__echo",
            arguments: "{\"text\":\"hello\"}"
          }
        }
      ]
    },
    {
      role: "assistant",
      content: "done"
    }
  ]);

  const agent = new ReactToolAgent(client, "test-model", new ToolRegistry([]), context);
  const output = await agent.run({
    systemPrompt: "system",
    userPrompt: "user",
    allowedTools: ["mcp__demo__echo"],
    additionalToolDefinitions: [additionalTool],
    maxTurns: 3
  });

  assert.equal(mcpCalls.length, 1);
  assert.equal(mcpCalls[0].name, "mcp__demo__echo");
  assert.deepEqual(mcpCalls[0].args, { text: "hello" });
  assert.equal(output.toolCalls.length, 1);
  assert.equal(output.toolCalls[0].result.ok, true);
  assert.equal(output.finalText, "done");
  assert.equal(client.capturedTools?.some((tool) => tool.function.name === "mcp__demo__echo"), true);
});
