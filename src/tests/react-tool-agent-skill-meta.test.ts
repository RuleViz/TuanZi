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

function createContext(): ToolExecutionContext {
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
      info() {},
      warn() {},
      error() {}
    },
    agentSettings: minimalSettings
  };
}

test("ReactToolAgent should inject visible and hidden skill context messages for skill_load", async () => {
  const skillLoadTool: Tool = {
    definition: {
      name: "skill_load",
      description: "Load skill content.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" }
        }
      },
      readOnly: true
    },
    async execute() {
      return {
        ok: true,
        data: {
          requested: ["brainstorming"],
          loadedCount: 1,
          missing: [],
          skills: [
            {
              name: "brainstorming",
              description: "Turn ideas into designs",
              body: "SECRET_SKILL_BODY",
              skillDir: "/tmp/brainstorming"
            }
          ]
        }
      };
    }
  };

  const client = new SequenceClient([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-skill-load",
          type: "function",
          function: {
            name: "skill_load",
            arguments: "{\"name\":\"brainstorming\"}"
          }
        }
      ]
    },
    {
      role: "assistant",
      content: "done"
    }
  ]);

  const agent = new ReactToolAgent(client, "test-model", new ToolRegistry([skillLoadTool]), createContext());
  const output = await agent.run({
    systemPrompt: "system",
    userPrompt: "load skill",
    allowedTools: ["skill_load"],
    maxTurns: 4
  });

  assert.equal(output.finalText, "done");
  assert.equal(output.toolCalls.length, 1);

  const callResultText = JSON.stringify(output.toolCalls[0].result);
  assert.equal(callResultText.includes("SECRET_SKILL_BODY"), false);
  assert.equal(callResultText.includes("loadedSkills"), true);

  const secondRequest = client.requests[1];
  assert.equal(Array.isArray(secondRequest), true);

  const visibleMessage = secondRequest.find(
    (message) =>
      message.role === "assistant" &&
      typeof message.content === "string" &&
      message.content.includes("<command-message>Skill \"brainstorming\" is loading</command-message>")
  );
  assert.equal(Boolean(visibleMessage), true);
  assert.equal((visibleMessage as ChatMessage).isMeta === true, false);

  const toolMessage = secondRequest.find((message) => message.role === "tool" && message.tool_call_id === "call-skill-load");
  assert.equal(Boolean(toolMessage), true);
  assert.equal(typeof toolMessage?.content, "string");
  assert.equal(String(toolMessage?.content).includes("SECRET_SKILL_BODY"), false);
  assert.equal(String(toolMessage?.content).includes("loadedSkills"), true);

  const hiddenMetaMessage = secondRequest.find(
    (message) =>
      message.role === "assistant" &&
      message.isMeta === true &&
      typeof message.content === "string" &&
      message.content.includes("SECRET_SKILL_BODY")
  );
  assert.equal(Boolean(hiddenMetaMessage), true);
});

test("ReactToolAgent should not inject hidden skill context when skill_load fails", async () => {
  const skillLoadTool: Tool = {
    definition: {
      name: "skill_load",
      description: "Load skill content.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" }
        }
      },
      readOnly: true
    },
    async execute() {
      return {
        ok: false,
        error: "load failed"
      };
    }
  };

  const client = new SequenceClient([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-skill-load",
          type: "function",
          function: {
            name: "skill_load",
            arguments: "{\"name\":\"brainstorming\"}"
          }
        }
      ]
    },
    {
      role: "assistant",
      content: "done"
    }
  ]);

  const agent = new ReactToolAgent(client, "test-model", new ToolRegistry([skillLoadTool]), createContext());
  const output = await agent.run({
    systemPrompt: "system",
    userPrompt: "load skill",
    allowedTools: ["skill_load"],
    maxTurns: 4
  });

  assert.equal(output.finalText, "done");
  assert.equal(output.toolCalls.length, 1);
  assert.equal(output.toolCalls[0].result.ok, false);

  const secondRequest = client.requests[1];
  const hiddenMetaMessages = secondRequest.filter((message) => message.isMeta === true);
  assert.equal(hiddenMetaMessages.length, 0);
});

test("ReactToolAgent should keep batch requested/missing summary and inject meta only for loaded skills", async () => {
  const skillLoadTool: Tool = {
    definition: {
      name: "skill_load",
      description: "Load skill content.",
      parameters: {
        type: "object",
        properties: {
          names: { type: "array", items: { type: "string" } }
        }
      },
      readOnly: true
    },
    async execute() {
      return {
        ok: true,
        data: {
          requested: ["doc", "missing-skill"],
          loadedCount: 1,
          missing: ["missing-skill"],
          skills: [
            {
              name: "doc",
              description: "Doc skill",
              body: "DOC_SKILL_BODY"
            }
          ]
        }
      };
    }
  };

  const client = new SequenceClient([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-skill-load",
          type: "function",
          function: {
            name: "skill_load",
            arguments: "{\"names\":[\"doc\",\"missing-skill\"]}"
          }
        }
      ]
    },
    {
      role: "assistant",
      content: "done"
    }
  ]);

  const agent = new ReactToolAgent(client, "test-model", new ToolRegistry([skillLoadTool]), createContext());
  const output = await agent.run({
    systemPrompt: "system",
    userPrompt: "load skill batch",
    allowedTools: ["skill_load"],
    maxTurns: 4
  });

  assert.equal(output.finalText, "done");
  const data = output.toolCalls[0].result.data as Record<string, unknown>;
  assert.deepEqual(data.requested, ["doc", "missing-skill"]);
  assert.deepEqual(data.missing, ["missing-skill"]);
  assert.equal(data.loadedCount, 1);
  assert.equal(JSON.stringify(output.toolCalls[0].result).includes("DOC_SKILL_BODY"), false);

  const secondRequest = client.requests[1];
  const hiddenMetaMessage = secondRequest.find(
    (message) => message.role === "assistant" && message.isMeta === true && String(message.content).includes("DOC_SKILL_BODY")
  );
  assert.equal(Boolean(hiddenMetaMessage), true);
});
