import assert from "node:assert/strict";
import { test } from "node:test";
import { ResumeSubagentTool } from "../tools/resume-subagent";
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

test("ResumeSubagentTool should delegate resume requests to subagentBridge", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const bridge: SubagentBridge = {
    async spawn() {
      return { subagentId: "subagent-1", status: "queued" };
    },
    async resume(input) {
      calls.push(input);
      return { subagentId: "subagent-1", status: "queued" };
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

  const tool = new ResumeSubagentTool();
  const result = await tool.execute(
    {
      snapshotId: "subagent-1",
      task: "continue the earlier search",
      context: "narrow to renderer"
    },
    createContext(bridge)
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      snapshotId: "subagent-1",
      task: "continue the earlier search",
      context: "narrow to renderer"
    }
  ]);
});
