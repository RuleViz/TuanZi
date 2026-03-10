import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolRegistry } from "../core/tool-registry";
import type { ApprovalDecision, ApprovalGate, BackupManager, Logger, ToolExecutionContext } from "../core/types";
import { ReactToolAgent, type ToolLoopResumeState } from "../agents/react-tool-agent";
import type { ChatCompletionClient, ChatCompletionResult, ChatMessage } from "../agents/model-types";

class FakeClient implements ChatCompletionClient {
  constructor(private readonly responder: (messages: ChatMessage[]) => ChatCompletionResult) { }

  async complete(input: { model: string; messages: ChatMessage[] }): Promise<ChatCompletionResult> {
    return this.responder(input.messages);
  }
}

class AllowAllApprovalGate implements ApprovalGate {
  async approve(): Promise<ApprovalDecision> {
    return { approved: true };
  }
}

class NoopBackupManager implements BackupManager {
  async backupFile(): Promise<string | null> {
    return null;
  }
}

class NoopLogger implements Logger {
  info(): void { }
  warn(): void { }
  error(): void { }
}

test("ReactToolAgent should continue from saved resume state", async () => {
  let capturedMessages: ChatMessage[] = [];
  const client = new FakeClient((messages) => {
    capturedMessages = messages.map((message) => ({ ...message }));
    return {
      message: {
        role: "assistant",
        content: "resumed done"
      }
    };
  });

  const context: ToolExecutionContext = {
    workspaceRoot: "E:/workspace",
    approvalGate: new AllowAllApprovalGate(),
    backupManager: new NoopBackupManager(),
    logger: new NoopLogger()
  };

  const agent = new ReactToolAgent(client, "demo-model", new ToolRegistry([]), context);
  const resumeState: ToolLoopResumeState = {
    version: 1,
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "view_file",
              arguments: "{\"path\":\"README.md\"}"
            }
          }
        ]
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        name: "view_file",
        content: JSON.stringify({ ok: true, data: { path: "README.md" } })
      }
    ],
    toolCalls: [
      {
        name: "view_file",
        args: { path: "README.md" },
        result: { ok: true, data: { path: "README.md" } }
      }
    ],
    allowedTools: [],
    temperature: 0.15,
    maxTurns: 6,
    nextTurn: 1,
    partialAssistantMessage: null
  };

  const result = await agent.run({
    systemPrompt: "system",
    userPrompt: "task",
    allowedTools: resumeState.allowedTools,
    resumeState
  });

  assert.equal(result.finalText, "resumed done");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "view_file");
  assert.equal(capturedMessages[capturedMessages.length - 1]?.role, "tool");
});
