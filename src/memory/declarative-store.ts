import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// ── Constants ──────────────────────────────────────────────────────────────

const MEMORY_FILE_NAME = "MEMORY.md";
const SOUL_FILE_NAME = "SOUL.md";
const PROJECT_MEMORY_DIR = ".tuanzi";

// ── Types ──────────────────────────────────────────────────────────────────

export type MemoryScope = "global" | "project";

export interface DeclarativeStoreOptions {
  /** Path to the global ~/.tuanzi/ directory. */
  globalDir: string;
}

// ── Implementation ─────────────────────────────────────────────────────────

/**
 * Manages declarative (Markdown file) long-term memory, inspired by Hermes Agent.
 *
 * File layout:
 *   <globalDir>/MEMORY.md    — cross-project user preferences and facts
 *   <globalDir>/SOUL.md      — agent persona (static, not modified by extraction)
 *   <workspaceRoot>/.tuanzi/MEMORY.md — project-scoped conventions and knowledge
 *
 * All I/O is synchronous to match the rest of the codebase.
 */
export class DeclarativeStore {
  private readonly globalDir: string;

  constructor(options: DeclarativeStoreOptions) {
    this.globalDir = options.globalDir;
  }

  // ── Read operations ──────────────────────────────────────────────────────

  /** Returns the contents of the global MEMORY.md, or "" if it doesn't exist. */
  getGlobalMemory(): string {
    return this.readFile(path.join(this.globalDir, MEMORY_FILE_NAME));
  }

  /**
   * Returns the contents of the project-scoped MEMORY.md,
   * or "" if it doesn't exist.
   */
  getProjectMemory(workspaceRoot: string): string {
    return this.readFile(this.projectMemoryPath(workspaceRoot));
  }

  /** Returns the contents of SOUL.md, or "" if it doesn't exist. */
  getSoul(): string {
    return this.readFile(path.join(this.globalDir, SOUL_FILE_NAME));
  }

  /**
   * Returns the byte length of the MEMORY.md file for the given scope.
   * Returns 0 when the file does not exist.
   */
  getMemorySize(scope: MemoryScope, workspaceRoot?: string): number {
    const filePath = scope === "global"
      ? path.join(this.globalDir, MEMORY_FILE_NAME)
      : this.projectMemoryPath(workspaceRoot ?? "");
    if (!existsSync(filePath)) return 0;
    return readFileSync(filePath, "utf8").length;
  }

  // ── Write operations ─────────────────────────────────────────────────────

  /**
   * Appends `content` to the end of the MEMORY.md for the given scope.
   * Creates the file (and directory) if it doesn't exist.
   */
  appendToMemory(content: string, scope: MemoryScope, workspaceRoot?: string): void {
    const filePath = scope === "global"
      ? path.join(this.globalDir, MEMORY_FILE_NAME)
      : this.projectMemoryPath(workspaceRoot ?? "");

    ensureParentDir(filePath);

    const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
    const separator = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
    writeFileSync(filePath, existing + separator + content + "\n", "utf8");
  }

  /**
   * Overwrites the entire MEMORY.md for the given scope with `content`.
   * Intended for LLM-driven memory pruning / compaction.
   */
  overwriteMemory(content: string, scope: MemoryScope, workspaceRoot?: string): void {
    const filePath = scope === "global"
      ? path.join(this.globalDir, MEMORY_FILE_NAME)
      : this.projectMemoryPath(workspaceRoot ?? "");

    ensureParentDir(filePath);
    writeFileSync(filePath, content, "utf8");
  }

  /**
   * Writes the agent persona to SOUL.md in the global directory.
   * Overwrites any existing content.
   */
  writeSoul(content: string): void {
    ensureParentDir(path.join(this.globalDir, SOUL_FILE_NAME));
    writeFileSync(path.join(this.globalDir, SOUL_FILE_NAME), content, "utf8");
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private projectMemoryPath(workspaceRoot: string): string {
    return path.join(workspaceRoot, PROJECT_MEMORY_DIR, MEMORY_FILE_NAME);
  }

  private readFile(filePath: string): string {
    if (!existsSync(filePath)) return "";
    return readFileSync(filePath, "utf8");
  }
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
