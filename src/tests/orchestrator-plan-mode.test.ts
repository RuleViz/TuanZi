import assert from "node:assert/strict";
import { test } from "node:test";
import { PlanToDoOrchestrator, type OrchestratorTaskSnapshot } from "../agents/orchestrator";
import type { ChatMessage } from "../agents/model-types";
import type { ToolLoopResumeState } from "../agents/react-tool-agent";
import type { AgentResult, ExecutionPlan, ToolExecutionContext } from "../core/types";

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
    data: {
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
    };
    exitReason: "completed";
    context: {
      messages: ChatMessage[];
      toolCalls: [];
    };
  }> {
    this.calls.push({
      task,
      resumeState: hooks?.resumeState
    });
    hooks?.onStateChange?.(createResumeState());
    return {
      data: {
        result: {
          summary: `coder-run-${this.calls.length}`,
          changedFiles: [],
          executedCommands: [],
          followUp: []
        },
        toolCalls: []
      },
      exitReason: "completed",
      context: {
        messages: [],
        toolCalls: []
      }
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
  ): Promise<AgentResult<{ plan: ExecutionPlan; toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: { ok: boolean; data?: unknown; error?: string }; timestamp: string }> }, ChatMessage, never>> {
    this.calls += 1;
    this.signals.push(signal);
    return {
      data: { plan: this.plan, toolCalls: [] },
      exitReason: "completed",
      context: {
        messages: [],
        toolCalls: []
      }
    };
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

  assert.match(result.data.summary, /not approved/i);
  assert.equal(result.data.toolCalls.length, 0);
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
  assert.match(result.data.summary, /Executed in plan mode/);
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
  assert.match(result.data.summary, /Executed in plan mode/);
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

  const result = await orchestrator.run(
    {
      task: "implement",
      forcePlanMode: true
    },
    {
      signal: controller.signal
    }
  );
  assert.equal(result.exitReason, "interrupted");
  assert.equal(planner.calls, 0);
});

test("direct mode should convert unexpected coder throws into a failed result", async () => {
  const plan: ExecutionPlan = {
    goal: "task",
    steps: [{ id: "S1", title: "Code 1", owner: "code", acceptance: "done" }]
  };
  const planner = new StubPlanner(plan);
  const orchestrator = new PlanToDoOrchestrator(
    {
      execute: async () => {
        throw new Error("coder exploded");
      }
    } as unknown as any,
    planner as unknown as any,
    createToolContext(true)
  );

  const phases: string[] = [];
  const taskSnapshots: OrchestratorTaskSnapshot[][] = [];
  const result = await orchestrator.run(
    {
      task: "how should we fix this?",
      forcePlanMode: false
    },
    {
      onPhaseChange: (phase) => {
        phases.push(phase);
      },
      onTasksChange: (tasks) => {
        taskSnapshots.push(tasks);
      }
    }
  );

  assert.equal(result.exitReason, "error");
  assert.equal(result.error, "coder exploded");
  assert.match(result.data.summary, /coder exploded/);
  assert.equal(taskSnapshots.at(-1)?.[0]?.status, "failed");
  assert.equal(taskSnapshots.at(-1)?.[0]?.detail, "coder exploded");
  assert.equal(phases.at(-1), "aborted");
  assert.equal(planner.calls, 0);
});

test("forcePlanMode=false should bypass auto plan even with plan-intent text", async () => {
  const plan: ExecutionPlan = {
    goal: "task",
    steps: [{ id: "S1", title: "Code 1", owner: "code", acceptance: "done" }]
  };
  const planner = new StubPlanner(plan);
  const coder = new StubCoder();
  const orchestrator = new PlanToDoOrchestrator(
    coder as unknown as any,
    planner as unknown as any,
    createToolContext(true)
  );

  await orchestrator.run({
    task: "please use plan mode for this",
    forcePlanMode: false
  });

  assert.equal(planner.calls, 0);
  assert.equal(coder.calls.length, 1);
});

test("plan mode task snapshot should include originCheckpointId on plan group header", async () => {
  const plan: ExecutionPlan = {
    goal: "task",
    steps: [{ id: "S1", title: "Code 1", owner: "code", acceptance: "done" }]
  };
  const orchestrator = new PlanToDoOrchestrator(
    new StubCoder() as unknown as any,
    new StubPlanner(plan) as unknown as any,
    createToolContext(true)
  );
  const snapshots: OrchestratorTaskSnapshot[][] = [];

  await orchestrator.run(
    {
      task: "implement",
      forcePlanMode: true,
      originCheckpointId: "cp-1"
    },
    {
      onTasksChange: (tasks) => {
        snapshots.push(tasks);
      }
    }
  );

  const planHeader = snapshots.flat().find((item) => item.kind === "plan");
  assert.ok(planHeader);
  assert.equal(planHeader?.originCheckpointId, "cp-1");
});
