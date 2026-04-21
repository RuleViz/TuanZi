import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { EpisodicMemoryService } from "../core/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "system";
export type SessionImportance = "high" | "medium" | "low";

export interface SessionRow {
  id: string;
  workspace: string | null;
  started_at: number;
  ended_at: number | null;
  summary: string | null;
  access_count: number;
  last_accessed: number | null;
  importance: SessionImportance;
}

export interface MessageRow {
  id: number;
  session_id: string;
  role: MessageRole;
  content: string;
  created_at: number;
}

export interface SearchHit {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  rank: number;
}

export interface SearchOptions {
  workspace?: string;
  limit?: number;
  /** Exclude this session from results (e.g., the current active session). */
  beforeSession?: string;
}

export interface GCOptions {
  halfLifeDays: number;
  gcThreshold: number;
  keepRecentCount: number;
}

// ─── EpisodicStore ────────────────────────────────────────────────────────────

export class EpisodicStore implements EpisodicMemoryService {
  private db: Database.Database;

  constructor(options: { dbPath: string }) {
    mkdirSync(path.dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.initialize();
  }

  private initialize(): void {
    this.db.pragma("journal_mode=WAL");
    this.db.pragma("foreign_keys=ON");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        workspace     TEXT,
        started_at    INTEGER NOT NULL,
        ended_at      INTEGER,
        summary       TEXT,
        access_count  INTEGER NOT NULL DEFAULT 0,
        last_accessed INTEGER,
        importance    TEXT NOT NULL DEFAULT 'medium'
                      CHECK(importance IN ('high', 'medium', 'low'))
      );

      CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role        TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
        content     TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content=messages,
        content_rowid=id
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES('delete', old.id, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
  }

  // ─── Session Management ──────────────────────────────────────────────────

  beginSession(sessionId: string, workspaceRoot?: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (id, workspace, started_at)
         VALUES (?, ?, ?)`
      )
      .run(sessionId, workspaceRoot ?? null, Date.now());
  }

  endSession(sessionId: string, summary?: string, importance?: SessionImportance): void {
    this.db
      .prepare(
        `UPDATE sessions SET ended_at = ?, summary = ?, importance = COALESCE(?, importance)
         WHERE id = ?`
      )
      .run(Date.now(), summary ?? null, importance ?? null, sessionId);
  }

  getSession(sessionId: string): SessionRow | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRow | undefined;
    return row ?? null;
  }

  deleteSession(sessionId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }

  // ─── Message Storage ─────────────────────────────────────────────────────

  appendMessage(sessionId: string, role: MessageRole, content: string): void {
    this.db
      .prepare(
        `INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)`
      )
      .run(sessionId, role, content, Date.now());
  }

  getMessages(sessionId: string): MessageRow[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as MessageRow[];
  }

  // ─── FTS5 Full-text Search ────────────────────────────────────────────────

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const { workspace, limit = 20, beforeSession } = options;

    let sql = `
      SELECT
        m.session_id AS sessionId,
        m.role,
        m.content,
        m.created_at AS createdAt,
        messages_fts.rank
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.id
      JOIN sessions s ON m.session_id = s.id
      WHERE messages_fts MATCH ?
    `;
    const params: (string | number)[] = [query];

    if (workspace !== undefined) {
      sql += " AND s.workspace = ?";
      params.push(workspace);
    }
    if (beforeSession !== undefined) {
      sql += " AND m.session_id != ?";
      params.push(beforeSession);
    }

    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);

    let hits: SearchHit[];
    try {
      hits = this.db.prepare(sql).all(...params) as SearchHit[];
    } catch {
      // FTS5 syntax errors (e.g., empty query) → return empty
      return [];
    }

    if (hits.length > 0) {
      this.updateAccessCounts(hits.map(h => h.sessionId));
    }

    return hits;
  }

  private updateAccessCounts(sessionIds: string[]): void {
    const now = Date.now();
    const unique = [...new Set(sessionIds)];
    const updateStmt = this.db.prepare(
      `UPDATE sessions
       SET access_count = access_count + 1, last_accessed = ?
       WHERE id = ?`
    );
    const updateMany = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        updateStmt.run(now, id);
      }
    });
    updateMany(unique);
  }

  // ─── Decay Score ──────────────────────────────────────────────────────────

  /**
   * Compute the Ebbinghaus-inspired decay score for a session.
   * score = log2(1 + access_count) * 0.5^(Δt / halfLifeDays)
   * Returns 0 for sessions that have never been accessed.
   */
  computeDecayScore(
    session: Pick<SessionRow, "access_count" | "last_accessed" | "importance">,
    now: number,
    halfLifeDays: number
  ): number {
    if (session.access_count === 0 || session.last_accessed === null) {
      return 0;
    }
    const deltaDays = (now - session.last_accessed) / (24 * 60 * 60 * 1000);
    return Math.log2(1 + session.access_count) * Math.pow(0.5, deltaDays / halfLifeDays);
  }

  // ─── Garbage Collection ───────────────────────────────────────────────────

  runGC(options: GCOptions): void {
    const { gcThreshold, keepRecentCount, halfLifeDays } = options;
    const now = Date.now();

    const sessions = this.db
      .prepare(
        `SELECT id, access_count, last_accessed, importance, ended_at
         FROM sessions
         WHERE ended_at IS NOT NULL
         ORDER BY ended_at DESC`
      )
      .all() as (SessionRow & { ended_at: number })[];

    // Always keep the N most recent sessions
    const recentIds = new Set(sessions.slice(0, keepRecentCount).map(s => s.id));

    const toDelete = sessions.filter(s => {
      if (recentIds.has(s.id)) return false;
      if (s.importance === "high") return false;
      const score = this.computeDecayScore(s, now, halfLifeDays);
      return score < gcThreshold;
    });

    if (toDelete.length === 0) return;

    const deleteMany = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      }
    });
    deleteMany(toDelete.map(s => s.id));

    // Rebuild FTS index to remove stale entries
    this.db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')").run();
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
