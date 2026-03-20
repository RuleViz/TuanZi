import assert from "node:assert/strict";
import { test } from "node:test";
import { ListSubagentsTool } from "../tools/list-subagents";
import { SpawnSubagentTool } from "../tools/spawn-subagent";
import { WaitSubagentsTool } from "../tools/wait-subagents";
import type { SubagentBridge, ToolExecutionContext } from "../core/types";

function createContext(bridge?: SubagentBridge): ToolExecutionContext {
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
    ...(bridge ? { subagentBridge: bridge } : {})
  };
}

test("SpawnSubagentTool should delegate task creation to subagentBridge", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const bridge: SubagentBridge = {
    async spawn(input) {
      calls.push(input);
      return {
        subagentId: "subagent-1",
        status: "queued"
      };
    },
    async wait() {
      return {
        completed: [],
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

  const tool = new SpawnSubagentTool();
  const result = await tool.execute(
    {
      task: "search auth flow",
      context: "look in ipc and renderer",
      agentType: "explorer"
    },
    createContext(bridge)
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      task: "search auth flow",
      context: "look in ipc and renderer",
      agentType: "explorer"
    }
  ]);
});

test("WaitSubagentsTool and ListSubagentsTool should pass through bridge options", async () => {
  const waitCalls: unknown[] = [];
  const listCalls: Array<Record<string, unknown>> = [];
  const completedSnapshot = {
    id: "subagent-1",
    parentTaskId: "parent-task",
    kind: "explorer" as const,
    status: "completed" as const,
    task: "search auth flow",
    context: "focus on renderer",
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-20T00:00:01.000Z",
    startedAt: "2026-03-20T00:00:00.100Z",
    completedAt: "2026-03-20T00:00:01.000Z",
    result: {
      summary: "found auth files",
      fullText: "full raw subagent output",
      references: [],
      webReferences: [],
      toolCalls: [
        {
          id: "call-read-1",
          name: "read",
          args: { path: "src/auth.ts" },
          result: { ok: true, data: { content: "auth content" } }
        }
      ],
      completedAt: "2026-03-20T00:00:01.000Z"
    }
  } as any;
  const bridge: SubagentBridge = {
    async spawn() {
      return {
        subagentId: "subagent-1",
        status: "queued"
      };
    },
    async wait(input) {
      waitCalls.push(input);
      return {
        completed: [completedSnapshot],
        pending: [],
        timedOut: true
      };
    },
    async list(status) {
      listCalls.push({ status: status ?? null });
      return [completedSnapshot];
    },
    async dispose() {
      return;
    }
  };

  const waitTool = new WaitSubagentsTool();
  const listTool = new ListSubagentsTool();

  const waitResult = await waitTool.execute(
    {
      ids: ["subagent-1", "subagent-2"],
      waitMode: "all",
      timeoutMs: 50
    },
    createContext(bridge)
  );
  const listResult = await listTool.execute({ status: "completed" }, createContext(bridge));

  assert.equal(waitResult.ok, true);
  assert.equal(listResult.ok, true);
  assert.deepEqual(waitResult.data, {
    completed: [
      {
        subagentId: "subagent-1",
        parentTaskId: "parent-task",
        kind: "explorer",
        task: "search auth flow",
        context: "focus on renderer",
        status: "completed",
        createdAt: "2026-03-20T00:00:00.000Z",
        updatedAt: "2026-03-20T00:00:01.000Z",
        startedAt: "2026-03-20T00:00:00.100Z",
        completedAt: "2026-03-20T00:00:01.000Z",
        summary: "found auth files",
        fullText: "full raw subagent output",
        references: [],
        webReferences: [],
        toolCalls: [
          {
            id: "call-read-1",
            name: "read",
            args: { path: "src/auth.ts" },
            result: { ok: true, data: { content: "auth content" } }
          }
        ],
        error: null
      }
    ],
    pending: [],
    timedOut: true
  });
  assert.deepEqual(waitCalls, [
    {
      ids: ["subagent-1", "subagent-2"],
      waitMode: "all",
      timeoutMs: 50
    }
  ]);
  assert.deepEqual(listCalls, [{ status: "completed" }]);
  assert.deepEqual(listResult.data, {
    subagents: [
      {
        subagentId: "subagent-1",
        parentTaskId: "parent-task",
        kind: "explorer",
        task: "search auth flow",
        context: "focus on renderer",
        status: "completed",
        createdAt: "2026-03-20T00:00:00.000Z",
        updatedAt: "2026-03-20T00:00:01.000Z",
        startedAt: "2026-03-20T00:00:00.100Z",
        completedAt: "2026-03-20T00:00:01.000Z",
        summary: "found auth files",
        fullText: "full raw subagent output",
        references: [],
        webReferences: [],
        toolCalls: [
          {
            id: "call-read-1",
            name: "read",
            args: { path: "src/auth.ts" },
            result: { ok: true, data: { content: "auth content" } }
          }
        ],
        error: null
      }
    ]
  });
});

test("Subagent tools should fail clearly when bridge is unavailable", async () => {
  const tool = new SpawnSubagentTool();
  const result = await tool.execute({ task: "search auth flow" }, createContext());
  assert.equal(result.ok, false);
  assert.match(String(result.error), /subagent/i);
});
