import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EpisodicStore } from "../memory/episodic-store";

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "tuanzi-episodic-test-"));
}

/** Creates a store + temp dir and ensures both are cleaned up in finally. */
function withStore(fn: (store: EpisodicStore) => void): void {
  const dir = makeTmpDir();
  const store = new EpisodicStore({ dbPath: path.join(dir, "episodes.db") });
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── Schema Initialization ──────────────────────────────────────────────────

test("EpisodicStore: initializes database and tables on construction", () => {
  withStore(store => {
    assert.ok(store, "store should be created without error");
  });
});

// ─── Session Management ──────────────────────────────────────────────────────

test("EpisodicStore: beginSession creates a session row", () => {
  withStore(store => {
    store.beginSession("sess-001");
    const session = store.getSession("sess-001");
    assert.ok(session, "session should exist after beginSession");
    assert.equal(session!.id, "sess-001");
    assert.equal(session!.importance, "medium");
    assert.equal(session!.access_count, 0);
    assert.ok(session!.started_at > 0, "started_at should be set");
  });
});

test("EpisodicStore: beginSession stores workspaceRoot", () => {
  withStore(store => {
    store.beginSession("sess-002", "/workspace/my-project");
    const session = store.getSession("sess-002");
    assert.equal(session!.workspace, "/workspace/my-project");
  });
});

test("EpisodicStore: endSession sets ended_at and summary", () => {
  withStore(store => {
    store.beginSession("sess-003");
    store.endSession("sess-003", "Session about TypeScript refactoring");
    const session = store.getSession("sess-003");
    assert.ok(session!.ended_at && session!.ended_at > 0, "ended_at should be set");
    assert.equal(session!.summary, "Session about TypeScript refactoring");
  });
});

test("EpisodicStore: endSession without summary leaves summary null", () => {
  withStore(store => {
    store.beginSession("sess-004");
    store.endSession("sess-004");
    const session = store.getSession("sess-004");
    assert.equal(session!.summary, null);
  });
});

// ─── Message Storage ─────────────────────────────────────────────────────────

test("EpisodicStore: appendMessage stores messages for a session", () => {
  withStore(store => {
    store.beginSession("sess-005");
    store.appendMessage("sess-005", "user", "How do I refactor this TypeScript class?");
    store.appendMessage("sess-005", "assistant", "You can extract the method into a separate function.");

    const messages = store.getMessages("sess-005");
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[0].content, "How do I refactor this TypeScript class?");
    assert.equal(messages[1].role, "assistant");
  });
});

test("EpisodicStore: messages are deleted when session is deleted (cascade)", () => {
  withStore(store => {
    store.beginSession("sess-006");
    store.appendMessage("sess-006", "user", "Test message");
    store.deleteSession("sess-006");

    const messages = store.getMessages("sess-006");
    assert.equal(messages.length, 0, "messages should be cascade deleted");
  });
});

// ─── FTS5 Full-text Search ───────────────────────────────────────────────────

test("EpisodicStore: search returns hits matching the query", () => {
  withStore(store => {
    store.beginSession("sess-007");
    store.appendMessage("sess-007", "user", "How do I configure webpack for production?");
    store.appendMessage("sess-007", "assistant", "Set mode: production in webpack.config.js");
    store.endSession("sess-007");

    const hits = store.search("webpack production");
    assert.ok(hits.length > 0, "should find hits for 'webpack production'");
    assert.ok(hits.some(h => h.content.toLowerCase().includes("webpack")), "hit content should contain 'webpack'");
  });
});

test("EpisodicStore: search returns empty array when no match", () => {
  withStore(store => {
    store.beginSession("sess-008");
    store.appendMessage("sess-008", "user", "Hello world");
    store.endSession("sess-008");

    const hits = store.search("kubernetes terraform ansible");
    assert.equal(hits.length, 0);
  });
});

test("EpisodicStore: search respects workspace filter", () => {
  withStore(store => {
    store.beginSession("sess-009a", "/workspace/projectA");
    store.appendMessage("sess-009a", "user", "TypeScript strict mode configuration");
    store.endSession("sess-009a");

    store.beginSession("sess-009b", "/workspace/projectB");
    store.appendMessage("sess-009b", "user", "TypeScript strict mode in project B");
    store.endSession("sess-009b");

    const hits = store.search("TypeScript strict", { workspace: "/workspace/projectA" });
    assert.equal(hits.length, 1, "should only find messages from projectA");
    assert.equal(hits[0].sessionId, "sess-009a");
  });
});

test("EpisodicStore: search respects limit option", () => {
  withStore(store => {
    for (let i = 0; i < 5; i++) {
      store.beginSession(`sess-010-${i}`);
      store.appendMessage(`sess-010-${i}`, "user", `TypeScript refactoring session ${i}`);
      store.endSession(`sess-010-${i}`);
    }

    const hits = store.search("TypeScript refactoring", { limit: 2 });
    assert.equal(hits.length, 2, "should respect limit=2");
  });
});

// ─── Reference Counting (Access Count) ──────────────────────────────────────

test("EpisodicStore: search increments access_count for matched sessions", () => {
  withStore(store => {
    store.beginSession("sess-011");
    store.appendMessage("sess-011", "user", "Python async programming patterns");
    store.endSession("sess-011");

    const before = store.getSession("sess-011")!.access_count;
    assert.equal(before, 0);

    store.search("Python async");

    const after = store.getSession("sess-011")!.access_count;
    assert.equal(after, 1, "access_count should be incremented after a search hit");
  });
});

test("EpisodicStore: search updates last_accessed for matched sessions", () => {
  withStore(store => {
    store.beginSession("sess-012");
    store.appendMessage("sess-012", "user", "Docker containerization best practices");
    store.endSession("sess-012");

    const before = store.getSession("sess-012")!.last_accessed;
    assert.equal(before, null, "last_accessed should be null before any search");

    const t0 = Date.now();
    store.search("Docker containerization");

    const after = store.getSession("sess-012")!.last_accessed;
    assert.ok(after !== null && after >= t0, "last_accessed should be set to a recent timestamp");
  });
});

// ─── Decay Score & GC ────────────────────────────────────────────────────────

test("EpisodicStore: computeDecayScore returns 0 for never-accessed sessions", () => {
  withStore(store => {
    store.beginSession("sess-013");
    store.endSession("sess-013");

    const session = store.getSession("sess-013")!;
    const score = store.computeDecayScore(session, Date.now(), 30);
    assert.equal(score, 0, "never-accessed session should have score 0");
  });
});

test("EpisodicStore: computeDecayScore decreases as time passes", () => {
  withStore(store => {
    const now = Date.now();
    const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;
    const twoMonthsAgo = now - 60 * 24 * 60 * 60 * 1000;

    const sessionRecent = { id: "s1", access_count: 5, last_accessed: oneMonthAgo, importance: "medium" as const };
    const sessionOld = { id: "s2", access_count: 5, last_accessed: twoMonthsAgo, importance: "medium" as const };

    const scoreRecent = store.computeDecayScore(sessionRecent, now, 30);
    const scoreOld = store.computeDecayScore(sessionOld, now, 30);

    assert.ok(scoreRecent > scoreOld, `recent score (${scoreRecent.toFixed(3)}) should be higher than old score (${scoreOld.toFixed(3)})`);
  });
});

test("EpisodicStore: runGC deletes sessions below threshold (but keeps recent and high-importance)", () => {
  withStore(store => {
    // sess-gc-old: never accessed, should be GC'd
    store.beginSession("sess-gc-old");
    store.appendMessage("sess-gc-old", "user", "old irrelevant content");
    store.endSession("sess-gc-old");

    // sess-gc-high: high importance, should be kept
    store.beginSession("sess-gc-high");
    store.appendMessage("sess-gc-high", "user", "important milestone decision");
    store.endSession("sess-gc-high", undefined, "high");

    // sess-gc-recent: most recent, should be kept by keepRecentCount
    store.beginSession("sess-gc-recent");
    store.appendMessage("sess-gc-recent", "user", "recent work");
    store.endSession("sess-gc-recent");

    // Use very aggressive GC settings: threshold=1.0 deletes everything except high+recent
    store.runGC({ gcThreshold: 1.0, keepRecentCount: 1, halfLifeDays: 30 });

    assert.equal(store.getSession("sess-gc-old"), null, "old session should be GC'd");
    assert.ok(store.getSession("sess-gc-high"), "high-importance session should be kept");
    assert.ok(store.getSession("sess-gc-recent"), "most recent session should be kept");
  });
});
