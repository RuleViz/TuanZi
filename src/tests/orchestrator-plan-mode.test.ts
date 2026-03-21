import assert from "node:assert/strict";
import { test } from "node:test";
import { PlanToDoOrchestrator, type OrchestratorTaskSnapshot } from "../agents/orchestrator";
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
  calls = 0;
  signals: Array<AbortSignal | undefined> = [];

  constructor(private readonly plan: ExecutionPlan) {}

  async buildPlan(
    _task?: string,
    _conversationContext?: string,
    signal?: AbortSignal
  ): Promise<{ plan: ExecutionPlan; toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: { ok: boolean; data?: unknown; error?: string }; timestamp: string }> }> {
    this.calls += 1;
    this.signals.push(signal);
    return { plan: this.plan, toolCalls: [] };
  }
}

function createResumeState(
  anchor?: ToolLoopResumeState["resumeAnchor"],
  partialAssistantMessage: ToolLoopResumeState["partialAssistantMessage"] = null
): ToolLoopResumeState {
  return {
    version: 1,
    messages: [{ role: "system", content: "system" }, { role: "user", content: "task" }],
    toolCalls: [],
    allowedTools: [],
    temperature: 0.15,
    maxTurns: 6,
    nextTurn: 1,
    partialAssistantMessage,
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
  const planner = new StubPlanner(plan);
  const orchestrator = new PlanToDoOrchestrator(
    coder as unknown as any,
    planner as unknown as any,
    createToolContext(true)
  );

  const previews: string[] = [];
  const controller = new AbortController();

  const result = await orchestrator.run(
    {
      task: "how to optimize this function",
      forcePlanMode: true
    },
    {
      signal: controller.signal,
      onPlanPreview: (preview) => {
        previews.push(preview);
      }
    }
  );

  assert.equal(coder.calls.length, 1);
  assert.equal(previews.length, 1);
  assert.equal(planner.signals[0], controller.signal);
  assert.match(previews[0], /Goal: task/);
  assert.match(result.summary, /Executed in plan mode/);
});

test("plan mode one-shot should pass all steps to coder at once", async () => {
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
    createToolContext(true)
  );

  const result = await orchestrator.run({
    task: "implement",
    forcePlanMode: true
  });

  assert.equal(coder.calls.length, 1);
  assert.match(coder.calls[0].task, /S1/);
  assert.match(coder.calls[0].task, /S2/);
  assert.match(result.summary, /Executed in plan mode/);
});

test("plan mode should emit unique task group ids to avoid cross-plan collisions", async () => {
  const plan: ExecutionPlan = {
    goal: "task",
    steps: [{ id: "S1", title: "Code 1", owner: "code", acceptance: "done" }]
  };
  const coder = new StubCoder();
  const orchestrator = new PlanToDoOrchestrator(
    coder as unknown as any,
    new StubPlanner(plan) as unknown as any,
    createToolContext(true)
  );

  const snapshots: OrchestratorTaskSnapshot[][] = [];
  await orchestrator.run(
    {
      task: "implement",
      forcePlanMode: true
    },
    {
      onTasksChange: (tasks) => {
        snapshots.push(tasks);
      }
    }
  );

  assert.ok(snapshots.length > 0);
  const firstSnapshot = snapshots[0];
  const group = firstSnapshot.find((item) => item.kind === "plan");
  assert.ok(group);
  assert.notEqual(group.id, "plan-group-S1");

  const childTasks = firstSnapshot.filter((item) => item.parentGroupId);
  assert.equal(childTasks.length, 1);
  assert.equal(childTasks[0].parentGroupId, group.id);
});

test("plan mode should abort before planner when signal is already aborted", async () => {
  const plan: ExecutionPlan = {
    goal: "task",
    steps: [{ id: "S1", title: "Code 1", owner: "code", acceptance: "done" }]
  };
  const planner = new StubPlanner(plan);
  const orchestrator = new PlanToDoOrchestrator(
    new StubCoder() as unknown as any,
    planner as unknown as any,
    createToolContext(true)
  );

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      orchestrator.run(
        {
          task: "implement",
          forcePlanMode: true
        },
        {
          signal: controller.signal
        }
      ),
    /Interrupted by user/
  );
  assert.equal(planner.calls, 0);
});
