import assert from "node:assert/strict";
import { test } from "node:test";
import { PlanToDoOrchestrator } from "../agents/orchestrator";
import type { ToolLoopResumeState } from "../agents/react-tool-agent";
import type { ExecutionPlan, ToolExecutionContext } from "../core/types";

class StubCoder {
  calls: Array<{ task: string; resumeState?: ToolLoopResumeState }> = [];

  async execute(
    task: string,
    _conversationContext: string,
    hooks?: {
      onStateChange?: (state: ToolLoopResumeState) => void;
      resumeState?: ToolLoopResumeState;
    }
  ): Promise<{
    result: {
      summary: string;
      changedFiles: string[];
      executedCommands: Array<{ command: string; exitCode: number | null }>;
      followUp: string[];
    };
    toolCalls: Array<{
      toolName: string;
      args: Record<string, unknown>;
      result: { ok: boolean; data?: unknown; error?: string };
      timestamp: string;
    }>;
  }> {
    this.calls.push({
      task,
      resumeState: hooks?.resumeState
    });
    hooks?.onStateChange?.(createResumeState());
    return {
      result: {
        summary: `coder-run-${this.calls.length}`,
        changedFiles: [],
        executedCommands: [],
        followUp: []
      },
      toolCalls: []
    };
  }
}

class StubPlanner {
  constructor(private readonly plan: ExecutionPlan) {}

  async buildPlan(): Promise<ExecutionPlan> {
    return this.plan;
  }
}

class StubSearcher {
  calls = 0;

  async search(): Promise<{
    result: {
      summary: string;
      references: Array<{ path: string; reason: string; confidence: "low" | "medium" | "high" }>;
      webReferences: Array<{ url: string; reason: string }>;
    };
    toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: { ok: boolean }; timestamp: string }>;
  }> {
    this.calls += 1;
    return {
      result: {
        summary: "search-ok",
        references: [{ path: "E:/workspace/src/file.ts", reason: "hit", confidence: "medium" }],
        webReferences: []
      },
      toolCalls: []
    };
  }
}

function createResumeState(anchor?: ToolLoopResumeState["resumeAnchor"]): ToolLoopResumeState {
  return {
    version: 1,
    messages: [{ role: "system", content: "system" }, { role: "user", content: "task" }],
    toolCalls: [],
    allowedTools: [],
    temperature: 0.15,
    maxTurns: 6,
    nextTurn: 1,
    partialAssistantMessage: null,
    ...(anchor ? { resumeAnchor: anchor } : {})
  };
}

function createToolContext(approved: boolean): ToolExecutionContext {
  return {
    workspaceRoot: process.cwd(),
    approvalGate: {
      approve: async () => ({ approved, reason: approved ? undefined : "Rejected by test" })
    },
    backupManager: {
      backupFile: async () => null
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    },
    agentSettings: {
      routing: {
        enableDirectMode: true,
        defaultEnablePlanMode: false,
        directIntentPatterns: ["explain", "how"]
      },
      policy: {
        default: "allow",
        tools: {},
        commandRules: { deny: [], allow: [] }
      },
      webSearch: {
        enabled: false,
        provider: "mcp",
        maxUsesPerTask: 1,
        maxResultsPerUse: 1,
        maxCharsPerPage: 1000,
        cacheTtlMs: 1000
      },
      toolLoop: {
        searchMaxTurns: 2,
        coderMaxTurns: 2,
        noProgressRepeatTurns: 1
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
}

test("plan mode should stop execution when plan approval is rejected", async () => {
  const plan: ExecutionPlan = {
    goal: "task",
    steps: [{ id: "S1", title: "Edit code", owner: "code", acceptance: "done" }]
  };
  const coder = new StubCoder();
  const orchestrator = new PlanToDoOrchestrator(
    coder as unknown as any,
    new StubPlanner(plan) as unknown as any,
    new StubSearcher() as unknown as any,
    createToolContext(false)
  );

  const result = await orchestrator.run({ task: "please plan first", forcePlanMode: true });

  assert.match(result.summary, /not approved/i);
  assert.equal(result.toolCalls.length, 0);
});

test("forcePlanMode should emit plan preview without polluting text stream", async () => {
  const plan: ExecutionPlan = {
    goal: "task",
    steps: [{ id: "S1", title: "Edit code", owner: "code", acceptance: "done" }]
  };
  const coder = new StubCoder();
  const orchestrator = new PlanToDoOrchestrator(
    coder as unknown as any,
    new StubPlanner(plan) as unknown as any,
    new StubSearcher() as unknown as any,
    createToolContext(true)
  );

  const deltas: string[] = [];
  const previews: string[] = [];
  const states: ToolLoopResumeState[] = [];

  const result = await orchestrator.run(
    {
      task: "how to optimize this function",
      forcePlanMode: true
    },
    {
      onAssistantTextDelta: (delta) => {
        deltas.push(delta);
      },
      onPlanPreview: (preview) => {
        previews.push(preview);
      },
      onStateChange: (state) => {
        states.push(state);
      }
    }
  );

  assert.equal(coder.calls.length, 1);
  assert.equal(deltas.length, 0);
  assert.equal(previews.length, 1);
  assert.match(previews[0], /Goal: task/);
  assert.equal(states.length > 0, true);
  assert.deepEqual(states[0].resumeAnchor, {
    mode: "plan",
    stepId: "S1",
    stepIndex: 0
  });
  assert.match(result.summary, /Executed in plan mode/);
});

test("plan mode should resume from anchored step and skip earlier code steps", async () => {
  const plan: ExecutionPlan = {
    goal: "task",
    steps: [
      { id: "S1", title: "Code 1", owner: "code", acceptance: "done" },
      { id: "S2", title: "Code 2", owner: "code", acceptance: "done" }
    ]
  };
  const coder = new StubCoder();
  const orchestrator = new PlanToDoOrchestrator(
    coder as unknown as any,
    new StubPlanner(plan) as unknown as any,
    new StubSearcher() as unknown as any,
    createToolContext(true)
  );

  const resumeState = createResumeState({
    mode: "plan",
    stepId: "S2",
    stepIndex: 1
  });

  const result = await orchestrator.run({
    task: "implement",
    forcePlanMode: true,
    resumeState
  });

  assert.equal(coder.calls.length, 1);
  assert.equal(coder.calls[0].resumeState, resumeState);
  assert.match(result.summary, /S1 Code 1: skipped/);
  assert.match(result.summary, /S2 Code 2: resumed/);
});

test("plan mode should ignore unmatched resume anchor", async () => {
  const plan: ExecutionPlan = {
    goal: "task",
    steps: [{ id: "S1", title: "Code 1", owner: "code", acceptance: "done" }]
  };
  const coder = new StubCoder();
  const orchestrator = new PlanToDoOrchestrator(
    coder as unknown as any,
    new StubPlanner(plan) as unknown as any,
    new StubSearcher() as unknown as any,
    createToolContext(true)
  );

  const result = await orchestrator.run({
    task: "implement",
    forcePlanMode: true,
    resumeState: createResumeState({
      mode: "plan",
      stepId: "S9",
      stepIndex: 9
    })
  });

  assert.equal(coder.calls.length, 1);
  assert.equal(coder.calls[0].resumeState, undefined);
  assert.equal(result.followUp.some((item) => item.includes("ignored")), true);
});

test("plan mode should execute search steps before resume target", async () => {
  const plan: ExecutionPlan = {
    goal: "task",
    steps: [
      { id: "S1", title: "Search", owner: "search", acceptance: "done" },
      { id: "S2", title: "Code 1", owner: "code", acceptance: "done" },
      { id: "S3", title: "Code 2", owner: "code", acceptance: "done" }
    ]
  };
  const coder = new StubCoder();
  const searcher = new StubSearcher();
  const orchestrator = new PlanToDoOrchestrator(
    coder as unknown as any,
    new StubPlanner(plan) as unknown as any,
    searcher as unknown as any,
    createToolContext(true)
  );

  const resumeState = createResumeState({
    mode: "plan",
    stepId: "S3",
    stepIndex: 2
  });

  await orchestrator.run({
    task: "implement",
    forcePlanMode: true,
    resumeState
  });

  assert.equal(searcher.calls, 1);
  assert.equal(coder.calls.length, 1);
  assert.equal(coder.calls[0].resumeState, resumeState);
});
