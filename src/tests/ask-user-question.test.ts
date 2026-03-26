import assert from "node:assert/strict";
import { test } from "node:test";
import { AskUserQuestionTool } from "../tools/ask-user-question";
import type { ToolExecutionContext, UserInteractionBridge } from "../core/types";

function makeMockContext(bridge?: UserInteractionBridge): ToolExecutionContext {
  return {
    workspaceRoot: "/tmp/test",
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    approvalGate: { approve: async () => ({ approved: true }) },
    agentSettings: null,
    sessionId: "test-session",
    userInteractionBridge: bridge ?? undefined
  } as unknown as ToolExecutionContext;
}

test("AskUserQuestionTool: returns error when bridge is not available", async () => {
  const tool = new AskUserQuestionTool();
  const result = await tool.execute({ fields: [] }, makeMockContext());
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("bridge is not available"));
});

test("AskUserQuestionTool: returns error for empty fields array", async () => {
  const tool = new AskUserQuestionTool();
  const bridge: UserInteractionBridge = {
    askQuestion: async () => ({ requestId: "r", answers: {}, skipped: false })
  };
  const result = await tool.execute({ fields: [] }, makeMockContext(bridge));
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("non-empty array"));
});

test("AskUserQuestionTool: returns error for missing field id", async () => {
  const tool = new AskUserQuestionTool();
  const bridge: UserInteractionBridge = {
    askQuestion: async () => ({ requestId: "r", answers: {}, skipped: false })
  };
  const result = await tool.execute(
    { fields: [{ type: "text", question: "Q?" }] },
    makeMockContext(bridge)
  );
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("id is required"));
});

test("AskUserQuestionTool: returns error for invalid type", async () => {
  const tool = new AskUserQuestionTool();
  const bridge: UserInteractionBridge = {
    askQuestion: async () => ({ requestId: "r", answers: {}, skipped: false })
  };
  const result = await tool.execute(
    { fields: [{ id: "f1", type: "checkbox", question: "Q?" }] },
    makeMockContext(bridge)
  );
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("type must be"));
});

test("AskUserQuestionTool: returns error for single_select without options", async () => {
  const tool = new AskUserQuestionTool();
  const bridge: UserInteractionBridge = {
    askQuestion: async () => ({ requestId: "r", answers: {}, skipped: false })
  };
  const result = await tool.execute(
    { fields: [{ id: "f1", type: "single_select", question: "Pick one" }] },
    makeMockContext(bridge)
  );
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("options is required"));
});

test("AskUserQuestionTool: returns error for duplicate field ids", async () => {
  const tool = new AskUserQuestionTool();
  const bridge: UserInteractionBridge = {
    askQuestion: async () => ({ requestId: "r", answers: {}, skipped: false })
  };
  const result = await tool.execute(
    {
      fields: [
        { id: "dup", type: "text", question: "Q1" },
        { id: "dup", type: "text", question: "Q2" }
      ]
    },
    makeMockContext(bridge)
  );
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("Duplicate field id"));
});

test("AskUserQuestionTool: successfully asks question and returns answers", async () => {
  const tool = new AskUserQuestionTool();
  let capturedRequest: unknown = null;
  const bridge: UserInteractionBridge = {
    askQuestion: async (req) => {
      capturedRequest = req;
      return { requestId: req.requestId, answers: { lang: "typescript" }, skipped: false };
    }
  };
  const result = await tool.execute(
    {
      title: "Setup",
      description: "Configure project",
      fields: [
        {
          id: "lang",
          type: "single_select",
          question: "Language?",
          options: [
            { label: "TypeScript", value: "typescript" },
            { label: "JavaScript", value: "javascript" }
          ]
        }
      ]
    },
    makeMockContext(bridge)
  );
  assert.equal(result.ok, true);
  assert.ok(capturedRequest !== null);
  const data = result.data as { requestId: string; skipped: boolean; answers: Record<string, unknown> };
  assert.equal(data.skipped, false);
  assert.deepEqual(data.answers, { lang: "typescript" });
  assert.ok(typeof data.requestId === "string" && data.requestId.length > 0);
});

test("AskUserQuestionTool: handles skipped response", async () => {
  const tool = new AskUserQuestionTool();
  const bridge: UserInteractionBridge = {
    askQuestion: async () => ({ requestId: "r", answers: {}, skipped: true })
  };
  const result = await tool.execute(
    {
      fields: [{ id: "q1", type: "text", question: "Any notes?" }]
    },
    makeMockContext(bridge)
  );
  assert.equal(result.ok, true);
  const data = result.data as { skipped: boolean };
  assert.equal(data.skipped, true);
});

test("AskUserQuestionTool: handles bridge error gracefully", async () => {
  const tool = new AskUserQuestionTool();
  const bridge: UserInteractionBridge = {
    askQuestion: async () => {
      throw new Error("connection lost");
    }
  };
  const result = await tool.execute(
    {
      fields: [{ id: "q1", type: "text", question: "Any notes?" }]
    },
    makeMockContext(bridge)
  );
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("connection lost"));
});

test("AskUserQuestionTool: handles abort/cancel error", async () => {
  const tool = new AskUserQuestionTool();
  const bridge: UserInteractionBridge = {
    askQuestion: async () => {
      throw new Error("abort");
    }
  };
  const result = await tool.execute(
    {
      fields: [{ id: "q1", type: "text", question: "Any notes?" }]
    },
    makeMockContext(bridge)
  );
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("cancelled"));
});

test("AskUserQuestionTool: definition has correct name", () => {
  const tool = new AskUserQuestionTool();
  assert.equal(tool.definition.name, "ask_user_question");
  assert.equal(tool.definition.readOnly, true);
});
