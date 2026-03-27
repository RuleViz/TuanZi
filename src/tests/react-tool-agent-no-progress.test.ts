import assert from "node:assert/strict";
import { test } from "node:test";
import { ReactToolAgent } from "../agents/react-tool-agent";
import type { ChatCompletionClient, ChatCompletionResult, ChatMessage } from "../agents/model-types";
import { ToolRegistry } from "../core/tool-registry";
import type { AgentSettings, Tool, ToolExecutionContext } from "../core/types";

class SequenceClient implements ChatCompletionClient {
  private index = 0;

  constructor(private readonly sequence: ChatMessage[]) {}

  async complete(): Promise<ChatCompletionResult> {
    const message = this.sequence[this.index] ?? {
      role: "assistant",
      content: "done"
    };
    this.index += 1;
    return { message };
  }
}

class MemoryLogger {
  public readonly infos: string[] = [];
  public readonly warns: string[] = [];
  public readonly errors: string[] = [];

  info(message: string): void {
    this.infos.push(message);
  }
  warn(message: string): void {
    this.warns.push(message);
  }
  error(message: string): void {
    this.errors.push(message);
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
    noProgressRepeatTurns: 1
  },
  contextPruning: {
    toolOutput: {
      protectRecentTokens: 40000,
      pruneMinimumTokens: 20000,
      pruneStrategy: "truncate"
    }
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

test("ReactToolAgent should stop when the same tool request repeats with no progress", async () => {
  const tool: Tool = {
    definition: {
      name: "noop_tool",
      description: "No-op tool for tests.",
      parameters: {
        type: "object",
        properties: {
          value: { type: "number" }
        }
      },
      readOnly: true
    },
    async execute() {
      return {
        ok: true,
        data: {
          echoed: true
        }
      };
    }
  };

  const registry = new ToolRegistry([tool]);
  const logger = new MemoryLogger();
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
    logger,
    agentSettings: minimalSettings
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
            arguments: "{\"value\":1}"
          }
        }
      ]
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-2",
          type: "function",
          function: {
            name: "noop_tool",
            arguments: "{\"value\":1}"
          }
        }
      ]
    }
  ]);

  const agent = new ReactToolAgent(client, "test-model", registry, context);
  const output = await agent.run({
    systemPrompt: "system",
    userPrompt: "user",
    allowedTools: ["noop_tool"],
    maxTurns: 5
  });

  assert.equal(output.toolCalls.length, 1);
  assert.match(output.finalText, /no-progress/i);
  assert.equal(logger.warns.some((line) => line.includes("no-progress breaker triggered")), true);
});
