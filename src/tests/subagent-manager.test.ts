import assert from "node:assert/strict";
import { test } from "node:test";
import { SubagentManager } from "../core/subagent-manager";
import type { SubagentResultSummary, SubagentSnapshot } from "../core/types";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buildSummary(summary: string): SubagentResultSummary {
  return {
    summary,
    fullText: summary,
    references: [],
    webReferences: [],
    toolCalls: [],
    completedAt: new Date().toISOString()
  } as any;
}

test("SubagentManager should cap concurrency and promote queued tasks when slots free", async () => {
  const runs: string[] = [];
  const taskSnapshots: SubagentSnapshot[][] = [];
  const first = createDeferred<SubagentResultSummary>();
  const second = createDeferred<SubagentResultSummary>();
  const third = createDeferred<SubagentResultSummary>();
  const deferreds = [first, second, third];

  const manager = new SubagentManager({
    maxConcurrent: 2,
    taskId: "parent-task",
    runExplorer: async ({ task }) => {
      const index = runs.push(task) - 1;
      return deferreds[index].promise;
    },
    onSnapshotsChange: (snapshots) => {
      taskSnapshots.push(snapshots);
    }
  });

  const firstSpawn = await manager.spawn({ task: "find auth files" });
  const secondSpawn = await manager.spawn({ task: "find session files" });
  const thirdSpawn = await manager.spawn({ task: "find ipc files" });

  assert.equal(firstSpawn.status, "queued");
  assert.equal(secondSpawn.status, "queued");
  assert.equal(thirdSpawn.status, "queued");

  await tick();

  const initial = await manager.list();
  assert.deepEqual(
    initial.map((item) => item.status),
    ["running", "running", "queued"]
  );
  assert.deepEqual(runs, ["find auth files", "find session files"]);

  first.resolve(buildSummary("auth done"));
  await tick();
  await tick();

  const afterFirstCompletion = await manager.list();
  assert.deepEqual(
    afterFirstCompletion.map((item) => item.status),
    ["completed", "running", "running"]
  );
  assert.deepEqual(runs, ["find auth files", "find session files", "find ipc files"]);

  second.resolve(buildSummary("session done"));
  third.resolve(buildSummary("ipc done"));

  const waited = await manager.wait({
    ids: [firstSpawn.subagentId, secondSpawn.subagentId, thirdSpawn.subagentId],
    waitMode: "all",
    timeoutMs: 100
  });

  assert.equal(waited.timedOut, false);
  assert.equal(waited.pending.length, 0);
  assert.equal(waited.completed.length, 3);
  assert.equal(taskSnapshots.length > 0, true);
});

test("SubagentManager should resolve any-mode waits after the first terminal subagent", async () => {
  const first = createDeferred<SubagentResultSummary>();
  const second = createDeferred<SubagentResultSummary>();

  const manager = new SubagentManager({
    maxConcurrent: 2,
    taskId: "parent-task",
    runExplorer: async ({ task }) => {
      return task === "a" ? first.promise : second.promise;
    }
  });

  const a = await manager.spawn({ task: "a" });
  const b = await manager.spawn({ task: "b" });
  await tick();

  first.resolve(buildSummary("a done"));
  const result = await manager.wait({
    ids: [a.subagentId, b.subagentId],
    waitMode: "any",
    timeoutMs: 100
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.completed.length, 1);
  assert.equal(result.completed[0].id, a.subagentId);
  assert.equal(result.pending.length, 1);

  second.resolve(buildSummary("b done"));
});

test("SubagentManager should cancel queued and running subagents when disposed", async () => {
  const abortedTasks: string[] = [];
  const manager = new SubagentManager({
    maxConcurrent: 1,
    taskId: "parent-task",
    runExplorer: async ({ task, signal }) => {
      return await new Promise<SubagentResultSummary>((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            abortedTasks.push(task);
            reject(new Error("aborted"));
          },
          { once: true }
        );
      });
    }
  });

  await manager.spawn({ task: "running-task" });
  await manager.spawn({ task: "queued-task" });
  await tick();

  await manager.dispose();
  await tick();

  const snapshots = await manager.list();
  assert.deepEqual(
    snapshots.map((item) => item.status),
    ["cancelled", "cancelled"]
  );
  assert.deepEqual(abortedTasks, ["running-task"]);
});
