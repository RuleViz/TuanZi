import assert from "node:assert/strict";
import { test } from "node:test";
import { ReactToolAgent } from "../agents/react-tool-agent";
import type { ChatCompletionClient, ChatCompletionResult, ChatMessage } from "../agents/model-types";
import { ToolRegistry } from "../core/tool-registry";
import type { AgentSettings, Tool, ToolExecutionContext } from "../core/types";

class SequenceClient implements ChatCompletionClient {
  private index = 0;
  public readonly requests: ChatMessage[][] = [];

  constructor(private readonly sequence: ChatMessage[]) {}

  async complete(input: { model: string; messages: ChatMessage[] }): Promise<ChatCompletionResult> {
    this.requests.push(JSON.parse(JSON.stringify(input.messages)) as ChatMessage[]);
    const message = this.sequence[this.index] ?? {
      role: "assistant",
      content: "done"
    };
    this.index += 1;
    return { message };
  }
}

const minimalSettings: AgentSettings = {
  routing: {
    enableDirectMode: true,
    defaultEnablePlanMode: false,
    directIntentPatterns: []
  },
  policy: {
    default: "allow",
    tools: {},
    commandRules: {
      deny: [],
      allow: []
    }
  },
  webSearch: {
    enabled: true,
    provider: "mcp",
    maxUsesPerTask: 2,
    maxResultsPerUse: 5,
    maxCharsPerPage: 20000,
    cacheTtlMs: 600000
  },
  toolLoop: {
    searchMaxTurns: 12,
    coderMaxTurns: 20,
    noProgressRepeatTurns: 2
  },
  mcp: {
    enabled: false,
    command: "",
    args: [],
    env: {},
    startupTimeoutMs: 15000,
    requestTimeoutMs: 30000
  },
  modelRequest: {
    reasoningEffort: null,
    thinking: {
      type: null,
      budgetTokens: null
    },
    extraBody: {}
  }
};

function extractWarningUsage(systemPrompt: string): number {
  const match = systemPrompt.match(/<system_warning>Token usage:\s*(\d+)\//);
  return match ? Number(match[1]) : 0;
}

test("ReactToolAgent should refresh system_warning token usage during tool loop", async () => {
  const tool: Tool = {
    definition: {
      name: "noop_tool",
      description: "No-op tool for tests.",
      parameters: {
        type: "object",
        properties: {}
      },
      readOnly: true
    },
    async execute() {
      return {
        ok: true,
        data: {
          payload: "x".repeat(200)
        }
      };
    }
  };

  const registry = new ToolRegistry([tool]);
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
      info() {},
      warn() {},
      error() {}
    },
    agentSettings: minimalSettings,
    modelTokenBudget: {
      total: 128000,
      reserve: 8000,
      limit: 120000
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
            name: "noop_tool",
            arguments: "{}"
          }
        }
      ]
    },
    {
      role: "assistant",
      content: "done"
    }
  ]);

  const agent = new ReactToolAgent(client, "test-model", registry, context);
  const output = await agent.run({
    systemPrompt: [
      "<system_prompt>",
      "  <token_budget>",
      "    <budget:token_budget>120000</budget:token_budget>",
      "    <system_warning>Token usage: 0/120000; 120000 remaining</system_warning>",
      "  </token_budget>",
      "</system_prompt>"
    ].join("\n"),
    userPrompt: "Please run one tool call.",
    allowedTools: ["noop_tool"],
    maxTurns: 4
  });

  assert.equal(output.finalText, "done");
  assert.equal(client.requests.length, 2);
  const firstSystemPrompt = client.requests[0]?.[0]?.content;
  const secondSystemPrompt = client.requests[1]?.[0]?.content;
  assert.equal(typeof firstSystemPrompt, "string");
  assert.equal(typeof secondSystemPrompt, "string");
  const firstUsage = extractWarningUsage(firstSystemPrompt as string);
  const secondUsage = extractWarningUsage(secondSystemPrompt as string);
  assert.equal(firstUsage > 0, true);
  assert.equal(secondUsage > firstUsage, true);
});

test("ReactToolAgent should keep compatibility when system prompt has no token budget tags", async () => {
  const client = new SequenceClient([
    {
      role: "assistant",
      content: "done"
    }
  ]);
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
      info() {},
      warn() {},
      error() {}
    },
    agentSettings: minimalSettings,
    modelTokenBudget: {
      total: 128000,
      reserve: 8000,
      limit: 120000
    }
  };

  const agent = new ReactToolAgent(client, "test-model", new ToolRegistry([]), context);
  const output = await agent.run({
    systemPrompt: "system without budget markers",
    userPrompt: "hello",
    allowedTools: [],
    maxTurns: 2
  });

  assert.equal(output.finalText, "done");
  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0][0].content, "system without budget markers");
});
