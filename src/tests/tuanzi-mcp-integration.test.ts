import assert from "node:assert/strict";
import { test } from "node:test";
import { TuanZiAgent } from "../agents/tuanzi";
import type {
  ChatCompletionClient,
  ChatCompletionResult,
  ChatMessage,
  ChatMessageContent
} from "../agents/model-types";
import { ToolRegistry } from "../core/tool-registry";
import type { StoredAgent } from "../core/agent-store";
import type {
  McpBridge,
  McpDiscoveredTool,
  ModelFunctionToolDefinition,
  ToolExecutionContext
} from "../core/types";

class CaptureClient implements ChatCompletionClient {
  lastInput: {
    model: string;
    messages: ChatMessage[];
    tools?: ModelFunctionToolDefinition[];
  } | null = null;

  async complete(input: {
    model: string;
    messages: ChatMessage[];
    tools?: ModelFunctionToolDefinition[];
  }): Promise<ChatCompletionResult> {
    this.lastInput = {
      model: input.model,
      messages: input.messages.map((message) => ({ ...message })),
      tools: input.tools
    };
    return {
      message: {
        role: "assistant",
        content: "done"
      }
    };
  }
}

function messageContentToText(content: ChatMessageContent): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  let text = "";
  for (const part of content) {
    if (part.type === "text") {
      text += part.text;
    }
  }
  return text;
}

test("TuanZiAgent should inject MCP tool schemas and prompt guidance", async () => {
  const mcpTools: McpDiscoveredTool[] = [
    {
      serverId: "files",
      toolName: "read_file",
      namespacedName: "mcp__files__read_file",
      description: "Read a file from external MCP file server.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" }
        },
        required: ["path"],
        additionalProperties: false
      }
    }
  ];

  const mcpDefinitions: ModelFunctionToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "mcp__files__read_file",
        description: "Read a file from external MCP file server.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    }
  ];

  const mcpBridge: McpBridge = {
    async callTool() {
      return { content: [] };
    },
    async listTools() {
      return mcpTools;
    },
    async getModelToolDefinitions() {
      return mcpDefinitions;
    }
  };

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
    mcpBridge
  };

  const activeAgent: StoredAgent = {
    id: "demo",
    filename: "demo.md",
    name: "Demo",
    avatar: "",
    description: "demo agent",
    tags: [],
    tools: [],
    prompt: "You are helpful.",
    readOnly: false
  };
  const client = new CaptureClient();
  const agent = new TuanZiAgent(client, "test-model", new ToolRegistry([]), context, activeAgent);
  const output = await agent.execute("Need MCP aware execution");

  assert.equal(output.result.summary, "done");
  assert.equal(client.lastInput !== null, true);
  assert.equal(client.lastInput?.tools?.some((tool) => tool.function.name === "mcp__files__read_file"), true);
  const systemContent = messageContentToText(
    client.lastInput?.messages.find((message) => message.role === "system")?.content ?? ""
  );
  const userContent = messageContentToText(
    client.lastInput?.messages.find((message) => message.role === "user")?.content ?? ""
  );
  assert.match(systemContent, /<tool_policies>/);
  assert.match(systemContent, /mcp__files__read_file/);
  assert.match(userContent, /Connected external MCP tools/);
  assert.match(userContent, /mcp__files__read_file/);
});
