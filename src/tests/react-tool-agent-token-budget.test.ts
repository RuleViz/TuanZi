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

class RoutingClient implements ChatCompletionClient {
  public readonly requests: ChatMessage[][] = [];
  public regularCalls = 0;
  public compactionCalls = 0;

  constructor(
    private readonly handlers: {
      onRegularCall?: (attempt: number, input: { model: string; messages: ChatMessage[] }) => Promise<ChatCompletionResult>;
      onCompactionCall?: (attempt: number, input: { model: string; messages: ChatMessage[] }) => Promise<ChatCompletionResult>;
    }
  ) {}

  async complete(input: { model: string; messages: ChatMessage[] }): Promise<ChatCompletionResult> {
    this.requests.push(JSON.parse(JSON.stringify(input.messages)) as ChatMessage[]);
    if (isCompactionRequest(input.messages)) {
      this.compactionCalls += 1;
      if (this.handlers.onCompactionCall) {
        return this.handlers.onCompactionCall(this.compactionCalls, input);
      }
      return {
        message: {
          role: "assistant",
          content: "compaction summary"
        }
      };
    }

    this.regularCalls += 1;
    if (this.handlers.onRegularCall) {
      return this.handlers.onRegularCall(this.regularCalls, input);
    }
    return {
      message: {
        role: "assistant",
        content: "done"
      }
    };
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
  contextPruning: {
    toolOutput: {
      protectRecentTokens: 40000,
      pruneMinimumTokens: 20000,
      pruneStrategy: "truncate"
    },
    compaction: {
      enabled: true,
      threshold: 0.85,
      maxRetries: 5
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
            arguments: "{\"value\":1}"
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

test("ReactToolAgent should prune old tool outputs before subsequent requests", async () => {
  const tool: Tool = {
    definition: {
      name: "noop_tool",
      description: "No-op tool for pruning tests.",
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
          payload: "x".repeat(600)
        }
      };
    }
  };

  const settingsWithPruning = {
    ...minimalSettings,
    contextPruning: {
      toolOutput: {
        protectRecentTokens: 80,
        pruneMinimumTokens: 20,
        pruneStrategy: "truncate"
      },
      compaction: {
        enabled: true,
        threshold: 0.85,
        maxRetries: 5
      }
    }
  } as AgentSettings;

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
    agentSettings: settingsWithPruning,
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
            arguments: "{\"value\":2}"
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
            arguments: "{\"value\":3}"
          }
        }
      ]
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-3",
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

  const agent = new ReactToolAgent(client, "test-model", new ToolRegistry([tool]), context);
  const output = await agent.run({
    systemPrompt: "system",
    userPrompt: "trigger multiple tool calls",
    allowedTools: ["noop_tool"],
    maxTurns: 8
  });

  assert.equal(output.finalText, "done");
  assert.equal(client.requests.length, 4);

  const placeholder = "[Tool output pruned - ";
  const sawPlaceholderInRequests = client.requests.some((request) =>
    request.some((message) => message.role === "tool" && typeof message.content === "string" && message.content.includes(placeholder))
  );
  assert.equal(sawPlaceholderInRequests, true);

  const finalRequestToolContents = client.requests[3]
    .filter((message) => message.role === "tool")
    .map((message) => (typeof message.content === "string" ? message.content : ""));
  assert.equal(finalRequestToolContents.some((content) => content.startsWith(placeholder)), true);
  assert.equal(finalRequestToolContents.some((content) => content.includes("\"payload\"")), true);
});

test("ReactToolAgent should not trigger compaction when usage is below threshold", async () => {
  const client = new RoutingClient({});
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
      total: 2000,
      reserve: 500,
      limit: 1500
    }
  };

  const agent = new ReactToolAgent(client, "test-model", new ToolRegistry([]), context);
  const output = await agent.run({
    systemPrompt: "system prompt",
    userPrompt: "short user prompt",
    allowedTools: [],
    maxTurns: 2
  });

  assert.equal(output.finalText, "done");
  assert.equal(output.exitReason, "completed");
  assert.equal(client.compactionCalls, 0);
  assert.equal(client.regularCalls, 1);
});

test("ReactToolAgent should skip compaction when pruning reduces usage under threshold", async () => {
  const client = new RoutingClient({});
  const settingsWithAggressivePruning: AgentSettings = {
    ...minimalSettings,
    contextPruning: {
      toolOutput: {
        protectRecentTokens: 100,
        pruneMinimumTokens: 1,
        pruneStrategy: "truncate"
      },
      compaction: {
        enabled: true,
        threshold: 0.85,
        maxRetries: 5
      }
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
      info() {},
      warn() {},
      error() {}
    },
    agentSettings: settingsWithAggressivePruning,
    modelTokenBudget: {
      total: 1800,
      reserve: 800,
      limit: 1000
    }
  };

  const resumeState = buildResumeState([
    { role: "system", content: "sys" },
    { role: "user", content: "continue task" },
    { role: "tool", tool_call_id: "call-1", name: "read", content: "x".repeat(4000) },
    { role: "tool", tool_call_id: "call-2", name: "read", content: "y".repeat(600) }
  ]);

  const agent = new ReactToolAgent(client, "test-model", new ToolRegistry([]), context);
  const output = await agent.run({
    systemPrompt: "ignored on resume",
    userPrompt: "ignored on resume",
    allowedTools: [],
    maxTurns: 2,
    resumeState
  });

  assert.equal(output.exitReason, "completed");
  assert.equal(client.compactionCalls, 0);
  const placeholderSeen = client.requests[0].some(
    (message) =>
      message.role === "tool" &&
      typeof message.content === "string" &&
      message.content.startsWith("[Tool output pruned - ")
  );
  assert.equal(placeholderSeen, true);
});

test("ReactToolAgent should compact context into [system, meta summary, last user] and continue", async () => {
  const client = new RoutingClient({
    onCompactionCall: async () => ({
      message: {
        role: "assistant",
        content: "Compacted summary text."
      }
    }),
    onRegularCall: async (_attempt, input) => {
      assert.equal(input.messages.length, 3);
      assert.equal(input.messages[0].role, "system");
      assert.equal(input.messages[1].role, "assistant");
      assert.equal(input.messages[1].isMeta, true);
      assert.equal(typeof input.messages[1].content, "string");
      assert.equal(input.messages[2].role, "user");
      return {
        message: {
          role: "assistant",
          content: "done"
        }
      };
    }
  });
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
      total: 1800,
      reserve: 800,
      limit: 1000
    }
  };

  const resumeState = buildResumeState([
    { role: "system", content: "sys" },
    { role: "user", content: "first user" },
    { role: "assistant", content: "A".repeat(6000) },
    { role: "user", content: "last user message for replay" }
  ]);

  const agent = new ReactToolAgent(client, "test-model", new ToolRegistry([]), context);
  const output = await agent.run({
    systemPrompt: "ignored on resume",
    userPrompt: "ignored on resume",
    allowedTools: [],
    maxTurns: 2,
    resumeState
  });

  assert.equal(output.exitReason, "completed");
  assert.equal(output.finalText, "done");
  assert.equal(client.compactionCalls, 1);
  assert.equal(client.regularCalls, 1);
});

test("ReactToolAgent should retry compaction up to 5 times and succeed on 5th attempt", async () => {
  const client = new RoutingClient({
    onCompactionCall: async (attempt) => {
      if (attempt < 5) {
        throw new Error(`transient compaction failure ${attempt}`);
      }
      return {
        message: {
          role: "assistant",
          content: "compacted summary after retries"
        }
      };
    }
  });
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
      total: 1800,
      reserve: 800,
      limit: 1000
    }
  };

  const resumeState = buildResumeState([
    { role: "system", content: "sys" },
    { role: "user", content: "first user" },
    { role: "assistant", content: "B".repeat(6000) },
    { role: "user", content: "last user message" }
  ]);

  const agent = new ReactToolAgent(client, "test-model", new ToolRegistry([]), context);
  const output = await agent.run({
    systemPrompt: "ignored on resume",
    userPrompt: "ignored on resume",
    allowedTools: [],
    maxTurns: 2,
    resumeState
  });

  assert.equal(output.exitReason, "completed");
  assert.equal(client.compactionCalls, 5);
  assert.equal(client.regularCalls, 1);
});

test("ReactToolAgent should return error when compaction fails after 5 retries", async () => {
  const client = new RoutingClient({
    onCompactionCall: async (attempt) => {
      throw new Error(`compaction failure ${attempt}`);
    }
  });
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
      total: 1800,
      reserve: 800,
      limit: 1000
    }
  };

  const resumeState = buildResumeState([
    { role: "system", content: "sys" },
    { role: "user", content: "first user" },
    { role: "assistant", content: "C".repeat(6000) },
    { role: "user", content: "last user message" }
  ]);

  const agent = new ReactToolAgent(client, "test-model", new ToolRegistry([]), context);
  const output = await agent.run({
    systemPrompt: "ignored on resume",
    userPrompt: "ignored on resume",
    allowedTools: [],
    maxTurns: 2,
    resumeState
  });

  assert.equal(output.exitReason, "error");
  assert.match(output.error ?? "", /ContextOverflowError/i);
  assert.equal(client.compactionCalls, 5);
  assert.equal(client.regularCalls, 0);
});

test("ReactToolAgent should return error when compacted context still exceeds hard limit", async () => {
  const client = new RoutingClient({
    onCompactionCall: async () => ({
      message: {
        role: "assistant",
        content: "Z".repeat(7000)
      }
    })
  });
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
      total: 1800,
      reserve: 800,
      limit: 1000
    }
  };

  const resumeState = buildResumeState([
    { role: "system", content: "sys" },
    { role: "user", content: "first user" },
    { role: "assistant", content: "D".repeat(6000) },
    { role: "user", content: "last user message" }
  ]);

  const agent = new ReactToolAgent(client, "test-model", new ToolRegistry([]), context);
  const output = await agent.run({
    systemPrompt: "ignored on resume",
    userPrompt: "ignored on resume",
    allowedTools: [],
    maxTurns: 2,
    resumeState
  });

  assert.equal(output.exitReason, "error");
  assert.match(output.error ?? "", /ContextOverflowError/i);
  assert.match(output.error ?? "", /still exceeds limit/i);
  assert.equal(client.compactionCalls, 1);
  assert.equal(client.regularCalls, 0);
});

function isCompactionRequest(messages: ChatMessage[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) {
    return false;
  }
  const first = messages[0];
  return (
    first.role === "system" &&
    typeof first.content === "string" &&
    first.content.includes("high-fidelity context compaction summaries")
  );
}

function buildResumeState(messages: ChatMessage[]) {
  return {
    version: 1 as const,
    messages: JSON.parse(JSON.stringify(messages)) as ChatMessage[],
    toolCalls: [],
    allowedTools: [],
    temperature: 0.2,
    maxTurns: 4,
    nextTurn: 0,
    partialAssistantMessage: null
  };
}
