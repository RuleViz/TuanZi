import assert from "node:assert/strict";
import { test } from "node:test";
import { SubagentExplorerAgent } from "../agents/subagent-explorer";
import type { ChatCompletionClient, ChatCompletionResult, ChatMessage } from "../agents/model-types";
import { ToolRegistry } from "../core/tool-registry";
import type { Tool, ToolExecutionContext } from "../core/types";

class SequenceClient implements ChatCompletionClient {
  private index = 0;

  constructor(private readonly sequence: ChatMessage[]) { }

  async complete(): Promise<ChatCompletionResult> {
    const message = this.sequence[this.index] ?? {
      role: "assistant",
      content: "{\"summary\":\"done\",\"references\":[],\"webReferences\":[]}"
    };
    this.index += 1;
    return { message };
  }
}

test("SubagentExplorerAgent should isolate internal tool logs from parent tool stream format", async () => {
  const logs: string[] = [];
  const readTool: Tool = {
    definition: {
      name: "read",
      description: "Read file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" }
        },
        required: ["path"],
        additionalProperties: false
      }
    },
    async execute() {
      return {
        ok: true,
        data: {
          content: "1: hello"
        }
      };
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
      info(message) {
        logs.push(message);
      },
      warn(message) {
        logs.push(message);
      },
      error(message) {
        logs.push(message);
      }
    }
  };

  const client = new SequenceClient([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-read-1",
          type: "function",
          function: {
            name: "read",
            arguments: JSON.stringify({ path: "README.md" })
          }
        }
      ]
    },
    {
      role: "assistant",
      content: JSON.stringify({
        summary: "found candidate file",
        references: [],
        webReferences: []
      })
    }
  ]);

  const agent = new SubagentExplorerAgent(client, "test-model", new ToolRegistry([readTool]), context);
  const result = await agent.run({
    task: "find readme usage",
    context: "focus on docs"
  });
  const detailedResult = result as typeof result & {
    fullText?: string;
    toolCalls?: Array<{ name: string }>;
  };

  assert.equal(result.summary, "found candidate file");
  assert.match(detailedResult.fullText ?? "", /"summary":"found candidate file"/);
  assert.equal(detailedResult.toolCalls?.length, 1);
  assert.equal(detailedResult.toolCalls?.[0]?.name, "read");
  assert.equal(logs.some((line) => line.startsWith("[tool] start ")), false);
  assert.equal(logs.some((line) => line.startsWith("[subagent:call-read-1] [tool] start read")), true);
});

test("SubagentExplorerAgent should fall back to collected tool evidence when tool loop hits max turns", async () => {
  const readTool: Tool = {
    definition: {
      name: "read",
      description: "Read file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" }
        },
        required: ["path"],
        additionalProperties: false
      }
    },
    async execute() {
      return {
        ok: true,
        data: {
          content: "1: export const answer = 42;",
          file: {
            path: "E:/project/Nice/MyCoderAgent/src/example.ts",
            content: "1: export const answer = 42;"
          }
        }
      };
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
    agentSettings: {
      routing: {
        enableDirectMode: false,
        directIntentPatterns: [],
        defaultEnablePlanMode: false
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
        enabled: false,
        provider: "mcp",
        maxUsesPerTask: 0,
        maxResultsPerUse: 0,
        maxCharsPerPage: 0,
        cacheTtlMs: 0
      },
      toolLoop: {
        searchMaxTurns: 1,
        coderMaxTurns: 1,
        noProgressRepeatTurns: 2
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
        startupTimeoutMs: 1000,
        requestTimeoutMs: 1000
      },
      modelRequest: {
        reasoningEffort: null,
        thinking: {
          type: null,
          budgetTokens: null
        },
        extraBody: {}
      }
    }
  };

  const client = new SequenceClient([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-read-max-turns",
          type: "function",
          function: {
            name: "read",
            arguments: JSON.stringify({ path: "src/example.ts" })
          }
        }
      ]
    }
  ]);

  const agent = new SubagentExplorerAgent(client, "test-model", new ToolRegistry([readTool]), context);
  const result = await agent.run({
    task: "find implementation evidence",
    context: "look for a concrete code reference"
  });
  const detailedResult = result as typeof result & {
    fullText?: string;
    toolCalls?: Array<{ name: string }>;
  };

  assert.doesNotMatch(result.summary, /max turns/i);
  assert.match(result.summary, /gathered evidence/i);
  assert.match(detailedResult.fullText ?? "", /max turns/i);
  assert.equal(detailedResult.toolCalls?.length, 1);
  assert.equal(detailedResult.toolCalls?.[0]?.name, "read");
  assert.deepEqual(result.references, [
    {
      path: "E:/project/Nice/MyCoderAgent/src/example.ts",
      reason: "Read during subagent exploration.",
      confidence: "high"
    }
  ]);
});
