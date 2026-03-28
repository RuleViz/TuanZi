import assert from "node:assert/strict";
import { test } from "node:test";
import { ReactToolAgent } from "../agents/react-tool-agent";
import type { ChatCompletionClient, ChatCompletionResult, ChatMessage } from "../agents/model-types";
import { ToolRegistry } from "../core/tool-registry";
import type { SubagentBridge, ToolExecutionContext } from "../core/types";
import { ListSubagentsTool } from "../tools/list-subagents";
import { ResumeSubagentTool } from "../tools/resume-subagent";
import { SpawnSubagentTool } from "../tools/spawn-subagent";
import { WaitSubagentsTool } from "../tools/wait-subagents";

class SequenceClient implements ChatCompletionClient {
  private index = 0;

  constructor(private readonly sequence: ChatMessage[]) { }

  async complete(): Promise<ChatCompletionResult> {
    const message = this.sequence[this.index] ?? {
      role: "assistant",
      content: "done"
    };
    this.index += 1;
    return { message };
  }
}

function createContext(bridge: SubagentBridge): ToolExecutionContext {
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
    subagentBridge: bridge
  };
}

test("ReactToolAgent should execute subagent tool calls and continue after wait", async () => {
  let spawned = false;
  const bridge: SubagentBridge = {
    async spawn() {
      spawned = true;
      return {
        subagentId: "subagent-1",
        status: "queued"
      };
    },
    async resume() {
      return {
        subagentId: "subagent-1",
        status: "queued"
      };
    },
    async wait() {
      return {
        completed: [
          {
            id: "subagent-1",
            parentTaskId: "parent-task",
            kind: "explorer",
            status: "completed",
            task: "search auth flow",
            context: "",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            result: {
              data: {
                summary: "found auth files",
                references: [],
                webReferences: [],
                fullTextPreview: "full raw subagent output",
                toolCallPreview: [],
                metadata: {
                  toolCalls: [],
                  turnCount: 1,
                  completedAt: new Date().toISOString()
                }
              },
              exitReason: "completed",
              context: {
                messages: [],
                toolCalls: []
              }
            }
          }
        ],
        pending: [],
        timedOut: false
      };
    },
    async list() {
      return [];
    },
    async dispose() {
      return;
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
            name: "spawn_subagent",
            arguments: JSON.stringify({
              task: "search auth flow"
            })
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
            name: "wait_subagents",
            arguments: JSON.stringify({
              ids: ["subagent-1"],
              waitMode: "all",
              timeoutMs: 100
            })
          }
        }
      ]
    },
    {
      role: "assistant",
      content: "Subagent summary integrated."
    }
  ]);

  const agent = new ReactToolAgent(
    client,
    "test-model",
    new ToolRegistry([new SpawnSubagentTool(), new ResumeSubagentTool(), new WaitSubagentsTool(), new ListSubagentsTool()]),
    createContext(bridge)
  );

  const output = await agent.run({
    systemPrompt: "system",
    userPrompt: "user",
    allowedTools: ["spawn_subagent", "wait_subagents", "list_subagents"],
    maxTurns: 4
  });

  assert.equal(spawned, true);
  assert.equal(output.toolCalls.length, 2);
  assert.equal(output.toolCalls[0].id, "call-1");
  assert.equal(output.toolCalls[1].id, "call-2");
  assert.equal(output.toolCalls[0].name, "spawn_subagent");
  assert.equal(output.toolCalls[1].name, "wait_subagents");
  assert.equal(output.finalText, "Subagent summary integrated.");
});
