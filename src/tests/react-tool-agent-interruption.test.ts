import assert from "node:assert/strict";
import { test } from "node:test";
import { ReactToolAgent } from "../agents/react-tool-agent";
import type { ChatCompletionClient, ChatCompletionResult } from "../agents/model-types";
import { ToolRegistry } from "../core/tool-registry";
import type { ToolExecutionContext } from "../core/types";

class UnusedClient implements ChatCompletionClient {
  async complete(): Promise<ChatCompletionResult> {
    throw new Error("complete should not be called for an already-aborted run");
  }
}

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
      info() {
        return;
      },
      warn() {
        return;
      },
      error() {
        return;
      }
    }
  };
}

test("ReactToolAgent should return interrupted result instead of throwing when signal is already aborted", async () => {
  const agent = new ReactToolAgent(new UnusedClient(), "test-model", new ToolRegistry([]), createContext());
  const controller = new AbortController();
  controller.abort();

  const output = await agent.run({
    systemPrompt: "system",
    userPrompt: "user",
    allowedTools: [],
    signal: controller.signal
  });

  assert.equal(output.exitReason, "interrupted");
  assert.match(output.error ?? "", /Interrupted by user/);
  assert.equal(output.data.finalText.includes("Interrupted by user"), true);
  assert.equal(output.context.messages.length, 2);
  assert.equal(output.context.toolCalls.length, 0);
  assert.equal(output.data.resumeState !== null, true);
});
