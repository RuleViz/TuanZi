import assert from "node:assert/strict";
import { test } from "node:test";
import { TuanZiAgent } from "../agents/tuanzi";
import type { ToolLoopResumeState } from "../agents/react-tool-agent";
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
  ToolCallRecord,
  ToolExecutionResult,
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

class SequenceClient implements ChatCompletionClient {
  private index = 0;
  constructor(private readonly sequence: ChatMessage[]) {}

  async complete(input: {
    model: string;
    messages: ChatMessage[];
    tools?: ModelFunctionToolDefinition[];
  }): Promise<ChatCompletionResult> {
    const message = this.sequence[this.index] ?? {
      role: "assistant",
      content: "done"
    };
    this.index += 1;
    return { message };
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

function createContext(mcpBridge: McpBridge): ToolExecutionContext {
  return {
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
}

function createAgent(tools: string[]): StoredAgent {
  return {
    id: "demo",
    filename: "demo.md",
    name: "Demo",
    avatar: "",
    description: "demo agent",
    tags: [],
    tools,
    prompt: "You are helpful.",
    readOnly: false
  };
}

function findTool(
  tools: ModelFunctionToolDefinition[] | undefined,
  name: string
): ModelFunctionToolDefinition | undefined {
  return tools?.find((tool) => tool.function.name === name);
}

test("TuanZiAgent should inject MCP tools in description-only mode and trim user MCP list", async () => {
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

  const context = createContext({
    async callTool() {
      return { content: [] };
    },
    async listTools() {
      return mcpTools;
    }
  });

  const client = new CaptureClient();
  const agent = new TuanZiAgent(client, "test-model", new ToolRegistry([]), context, createAgent([]));
  const output = await agent.execute("Need MCP aware execution");

  assert.equal(output.result.summary, "done");
  const injected = findTool(client.lastInput?.tools, "mcp__files__read_file");
  assert.equal(Boolean(injected), true);
  assert.deepEqual(injected?.function.parameters, {
    type: "object",
    properties: {},
    additionalProperties: true
  });

  const systemContent = messageContentToText(
    client.lastInput?.messages.find((message) => message.role === "system")?.content ?? ""
  );
  const userContent = messageContentToText(
    client.lastInput?.messages.find((message) => message.role === "user")?.content ?? ""
  );
  assert.match(systemContent, /<tool_policies>/);
  assert.match(systemContent, /mcp__files__read_file/);
  assert.doesNotMatch(userContent, /Connected external MCP tools/);
});

test("TuanZiAgent should filter MCP tools using active agent MCP permissions", async () => {
  const mcpTools: McpDiscoveredTool[] = [
    {
      serverId: "files",
      toolName: "read_file",
      namespacedName: "mcp__files__read_file",
      description: "Read file.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false
      }
    },
    {
      serverId: "files",
      toolName: "write_file",
      namespacedName: "mcp__files__write_file",
      description: "Write file.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false
      }
    }
  ];

  const context = createContext({
    async callTool() {
      return { content: [] };
    },
    async listTools() {
      return mcpTools;
    }
  });
  const client = new CaptureClient();
  const agent = new TuanZiAgent(
    client,
    "test-model",
    new ToolRegistry([]),
    context,
    createAgent(["mcp__files__read_file"])
  );
  await agent.execute("Need MCP filtering");

  const names = (client.lastInput?.tools ?? []).map((tool) => tool.function.name).sort();
  assert.deepEqual(names, ["mcp__files__read_file"]);
  const systemContent = messageContentToText(
    client.lastInput?.messages.find((message) => message.role === "system")?.content ?? ""
  );
  assert.match(systemContent, /mcp__files__read_file/);
  assert.doesNotMatch(systemContent, /mcp__files__write_file/);
});

test("TuanZiAgent should return MCP authorization error context and restore original bridge", async () => {
  const originalBridgeCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const originalBridge: McpBridge = {
    async callTool(name, args) {
      originalBridgeCalls.push({ name, args });
      return { content: [] };
    },
    async listTools() {
      return [
        {
          serverId: "files",
          toolName: "read_file",
          namespacedName: "mcp__files__read_file",
          description: "Read file.",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false }
        }
      ];
    }
  };

  const context = createContext(originalBridge);

  const client = new SequenceClient([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "mcp__files__delete_file",
            arguments: "{\"path\":\"README.md\"}"
          }
        }
      ]
    },
    {
      role: "assistant",
      content: "done"
    }
  ]);

  const agent = new TuanZiAgent(
    client,
    "test-model",
    new ToolRegistry([]),
    context,
    createAgent(["mcp__files__read_file"])
  );
  const resumeState: ToolLoopResumeState = {
    version: 1,
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "user" }
    ],
    toolCalls: [],
    allowedTools: ["mcp__files__delete_file"],
    temperature: 0.2,
    maxTurns: 3,
    nextTurn: 0,
    partialAssistantMessage: null
  };
  const output = await agent.execute("Try unauthorized call", "", { resumeState });

  assert.equal(output.result.summary, "done");
  assert.equal(output.toolCalls.length, 1);
  const firstCall = output.toolCalls[0] as ToolCallRecord & { result: ToolExecutionResult };
  assert.equal(firstCall.toolName, "mcp__files__delete_file");
  assert.equal(firstCall.result.ok, false);
  assert.match(String(firstCall.result.error), /not authorized/i);
  assert.equal(originalBridgeCalls.length, 0);
  assert.equal(context.mcpBridge, originalBridge);
});
