import { createHash } from "node:crypto";
import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "./types";

export interface TurnCheckpoint {
  id: string;
  turnIndex: number;
  userMessage: string;
  createdAt: string;
  toolCalls: string[];
}

export interface TurnCheckpointIndex {
  version: 2;
  checkpoints: TurnCheckpoint[];
}

export interface CheckpointManifest {
  files: Record<string, { hash: string; size: number }>;
}

const CHECKPOINTS_DIR = "checkpoints";
const INDEX_FILE = "index.json";
const MANIFESTS_DIR = "manifests";
const BLOBS_DIR = "blobs";
const MAX_CHECKPOINTS_DEFAULT = 50;
const MESSAGE_PREVIEW_LENGTH = 200;

const WORKSPACE_EXCLUDES = [
  ".git",
  ".tuanzi",
  "node_modules",
  ".npm-cache",
  ".tmp",
  "dist",
  "tmp",
  ".mycoderagent"
];

export class TurnCheckpointManager {
  private readonly checkpointRoot: string;
  private readonly workspaceRoot: string;
  private readonly logger: Logger;
  private readonly maxCheckpoints: number;
  private initialized = false;
  private mutexChain: Promise<void> = Promise.resolve();
  private lastManifest: CheckpointManifest | null = null;

  constructor(workspaceRoot: string, logger: Logger, maxCheckpoints?: number) {
    this.workspaceRoot = workspaceRoot;
    this.checkpointRoot = path.join(workspaceRoot, ".tuanzi", CHECKPOINTS_DIR);
    this.logger = logger;
    this.maxCheckpoints = maxCheckpoints ?? MAX_CHECKPOINTS_DEFAULT;
  }

  async createCheckpoint(turnId: string, turnIndex: number, userMessage: string): Promise<TurnCheckpoint | null> {
    return this.withMutex(async () => {
      try {
        await this.ensureInitialized();
        const manifest = await this.snapshotWorkspace();

        // Check if identical to last checkpoint
        const index = await this.loadIndex();
        if (index.checkpoints.length > 0) {
          const lastCp = index.checkpoints[index.checkpoints.length - 1];
          const lastManifest = await this.loadManifest(lastCp.id);
          if (lastManifest && manifestsEqual(manifest, lastManifest)) {
            return lastCp;
          }
        }

        const preview = truncateMessage(userMessage, MESSAGE_PREVIEW_LENGTH);
        const checkpoint: TurnCheckpoint = {
          id: turnId,
          turnIndex,
          userMessage: preview,
          createdAt: new Date().toISOString(),
          toolCalls: []
        };

        await this.saveManifest(turnId, manifest);
        index.checkpoints.push(checkpoint);
        await this.pruneAndGc(index);
        await this.saveIndex(index);
        this.lastManifest = manifest;

        return checkpoint;
      } catch (error) {
        this.logger.warn(`Failed to create checkpoint: ${toErrorMessage(error)}`);
        return null;
      }
    });
  }

  async updateCheckpointToolCalls(turnId: string, toolCalls: string[]): Promise<void> {
    return this.withMutex(async () => {
      try {
        const index = await this.loadIndex();
        const checkpoint = index.checkpoints.find((cp) => cp.id === turnId);
        if (checkpoint) {
          checkpoint.toolCalls = toolCalls;
          await this.saveIndex(index);
        }
      } catch {
        // Non-critical; silently ignore
      }
    });
  }

  async restore(turnId: string): Promise<{ restoredFiles: number; removedFiles: number } | null> {
    return this.withMutex(async () => {
      try {
        const index = await this.loadIndex();
        const checkpoint = index.checkpoints.find((cp) => cp.id === turnId);
        if (!checkpoint) {
          this.logger.error(`Checkpoint not found: ${turnId}`);
          return null;
        }

        const manifest = await this.loadManifest(turnId);
        if (!manifest) {
          this.logger.error(`Manifest not found for checkpoint: ${turnId}`);
          return null;
        }

        const stats = await this.restoreFromManifest(manifest);

        // Remove checkpoints after the restored one
        const cpIndex = index.checkpoints.findIndex((cp) => cp.id === turnId);
        if (cpIndex >= 0) {
          index.checkpoints.splice(cpIndex + 1);
          await this.saveIndex(index);
        }

        this.lastManifest = manifest;
        return stats;
      } catch (error) {
        this.logger.error(`Failed to restore checkpoint: ${toErrorMessage(error)}`);
        return null;
      }
    });
  }

  async restoreCodeOnly(turnId: string): Promise<{ restoredFiles: number; removedFiles: number } | null> {
    return this.restore(turnId);
  }

  async list(): Promise<TurnCheckpoint[]> {
    try {
      const index = await this.loadIndex();
      return [...index.checkpoints];
    } catch {
      return [];
    }
  }

  async diff(turnId: string): Promise<string | null> {
    try {
      const index = await this.loadIndex();
      const checkpoint = index.checkpoints.find((cp) => cp.id === turnId);
      if (!checkpoint) {
        return null;
      }
      const oldManifest = await this.loadManifest(turnId);
      if (!oldManifest) {
        return null;
      }
      const currentManifest = await this.snapshotWorkspace();
      return buildDiffSummary(oldManifest, currentManifest);
    } catch {
      return null;
    }
  }

  // -- Private helpers --

  private async withMutex<T>(fn: () => Promise<T>): Promise<T> {
    let resolve!: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    const prev = this.mutexChain;
    this.mutexChain = next;
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await fs.mkdir(path.join(this.checkpointRoot, MANIFESTS_DIR), { recursive: true });
    await fs.mkdir(path.join(this.checkpointRoot, BLOBS_DIR), { recursive: true });
    this.initialized = true;
  }

  private async snapshotWorkspace(): Promise<CheckpointManifest> {
    const files = await collectFiles(this.workspaceRoot, WORKSPACE_EXCLUDES);
    const manifest: CheckpointManifest = { files: {} };

    for (const relPath of files) {
      const absPath = path.join(this.workspaceRoot, relPath);
      try {
        const content = await fs.readFile(absPath);
        const hash = createHash("sha256").update(content).digest("hex");
        const normalizedRel = relPath.replace(/\\/g, "/");
        manifest.files[normalizedRel] = { hash, size: content.length };

        // Store blob if not already stored
        const blobPath = this.blobPath(hash);
        const blobExists = await fs.stat(blobPath).then(() => true).catch(() => false);
        if (!blobExists) {
          await fs.mkdir(path.dirname(blobPath), { recursive: true });
          const tmpPath = `${blobPath}.tmp.${Date.now()}`;
          await fs.writeFile(tmpPath, content);
          await fs.rename(tmpPath, blobPath);
        }
      } catch {
        // Skip files that can't be read
      }
    }

    return manifest;
  }

  private async restoreFromManifest(manifest: CheckpointManifest): Promise<{ restoredFiles: number; removedFiles: number }> {
    const stats = { restoredFiles: 0, removedFiles: 0 };
    const manifestPaths = new Set<string>();

    // 1) Restore all files from manifest
    for (const [relPath, entry] of Object.entries(manifest.files)) {
      manifestPaths.add(normalizePath(relPath));
      const destPath = path.join(this.workspaceRoot, relPath);
      const blobPath = this.blobPath(entry.hash);

      try {
        // Only copy if content differs
        const currentContent = await fs.readFile(destPath).catch(() => null);
        if (currentContent !== null) {
          const currentHash = createHash("sha256").update(currentContent).digest("hex");
          if (currentHash === entry.hash) {
            continue;
          }
        }
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.copyFile(blobPath, destPath);
        stats.restoredFiles += 1;
      } catch (err) {
        this.logger.warn(`Failed to restore file ${relPath}: ${toErrorMessage(err)}`);
      }
    }

    // 2) Remove files in workspace that don't exist in manifest
    const workspaceFiles = await collectFiles(this.workspaceRoot, WORKSPACE_EXCLUDES);
    for (const relPath of workspaceFiles) {
      if (!manifestPaths.has(normalizePath(relPath))) {
        const target = path.join(this.workspaceRoot, relPath);
        await fs.rm(target, { force: true }).catch(() => undefined);
        stats.removedFiles += 1;
      }
    }

    // 3) Remove empty directories
    if (stats.removedFiles > 0) {
      await removeEmptyDirs(this.workspaceRoot, WORKSPACE_EXCLUDES);
    }

    return stats;
  }

  private blobPath(hash: string): string {
    return path.join(this.checkpointRoot, BLOBS_DIR, hash.slice(0, 2), hash);
  }

  private async loadIndex(): Promise<TurnCheckpointIndex> {
    const indexPath = path.join(this.checkpointRoot, INDEX_FILE);
    try {
      const content = await fs.readFile(indexPath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      if (isValidIndex(parsed)) {
        return parsed;
      }
    } catch {
      // Index missing or corrupt; create fresh
    }
    return { version: 2, checkpoints: [] };
  }

  private async saveIndex(index: TurnCheckpointIndex): Promise<void> {
    const indexPath = path.join(this.checkpointRoot, INDEX_FILE);
    const tmpPath = `${indexPath}.tmp.${Date.now()}`;
    await fs.writeFile(tmpPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, indexPath);
  }

  private async loadManifest(checkpointId: string): Promise<CheckpointManifest | null> {
    const manifestPath = path.join(this.checkpointRoot, MANIFESTS_DIR, `${checkpointId}.json`);
    try {
      const content = await fs.readFile(manifestPath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      if (parsed && typeof parsed === "object" && "files" in parsed) {
        return parsed as CheckpointManifest;
      }
    } catch {
      // Missing or corrupt
    }
    return null;
  }

  private async saveManifest(checkpointId: string, manifest: CheckpointManifest): Promise<void> {
    const manifestPath = path.join(this.checkpointRoot, MANIFESTS_DIR, `${checkpointId}.json`);
    const tmpPath = `${manifestPath}.tmp.${Date.now()}`;
    await fs.writeFile(tmpPath, JSON.stringify(manifest), "utf8");
    await fs.rename(tmpPath, manifestPath);
  }

  private async pruneAndGc(index: TurnCheckpointIndex): Promise<void> {
    if (index.checkpoints.length <= this.maxCheckpoints) {
      return;
    }
    const excess = index.checkpoints.length - this.maxCheckpoints;
    const removed = index.checkpoints.splice(0, excess);

    // Collect hashes still referenced by remaining checkpoints
    const referencedHashes = new Set<string>();
    for (const cp of index.checkpoints) {
      const manifest = await this.loadManifest(cp.id);
      if (manifest) {
        for (const entry of Object.values(manifest.files)) {
          referencedHashes.add(entry.hash);
        }
      }
    }

    // Delete manifests and orphaned blobs for removed checkpoints
    for (const cp of removed) {
      const manifest = await this.loadManifest(cp.id);
      const manifestPath = path.join(this.checkpointRoot, MANIFESTS_DIR, `${cp.id}.json`);
      await fs.rm(manifestPath, { force: true }).catch(() => undefined);
      if (manifest) {
        for (const entry of Object.values(manifest.files)) {
          if (!referencedHashes.has(entry.hash)) {
            const blobFile = this.blobPath(entry.hash);
            await fs.rm(blobFile, { force: true }).catch(() => undefined);
          }
        }
      }
    }
  }
}

// -- Utility functions --

function truncateMessage(message: string, maxLength: number): string {
  const singleLine = message.replace(/\r?\n/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength)}...`;
}

function isValidIndex(value: unknown): value is TurnCheckpointIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.version === 2 && Array.isArray(record.checkpoints);
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

function shouldExclude(relativePath: string, excludes: string[]): boolean {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  for (const part of parts) {
    for (const exclude of excludes) {
      if (exclude.startsWith("*.")) {
        if (part.endsWith(exclude.slice(1))) {
          return true;
        }
      } else if (part === exclude) {
        return true;
      }
    }
  }
  return false;
}

async function collectFiles(rootDir: string, excludes: string[]): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string, rel: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (shouldExclude(entryRel, excludes)) {
        continue;
      }
      const entryAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryAbs, entryRel);
      } else if (entry.isFile()) {
        results.push(entryRel);
      }
    }
  }

  await walk(rootDir, "");
  return results;
}

async function removeEmptyDirs(rootDir: string, excludes: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (shouldExclude(entry.name, excludes)) {
      continue;
    }
    const dirPath = path.join(rootDir, entry.name);
    await removeEmptyDirs(dirPath, excludes);
    const remaining = await fs.readdir(dirPath).catch(() => ["placeholder"]);
    if (remaining.length === 0) {
      await fs.rmdir(dirPath).catch(() => undefined);
    }
  }
}

function manifestsEqual(a: CheckpointManifest, b: CheckpointManifest): boolean {
  const keysA = Object.keys(a.files).sort();
  const keysB = Object.keys(b.files).sort();
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) {
      return false;
    }
    if (a.files[keysA[i]].hash !== b.files[keysB[i]].hash) {
      return false;
    }
  }
  return true;
}

function buildDiffSummary(oldManifest: CheckpointManifest, newManifest: CheckpointManifest): string {
  const lines: string[] = [];
  const allPaths = new Set([...Object.keys(oldManifest.files), ...Object.keys(newManifest.files)]);
  for (const p of [...allPaths].sort()) {
    const oldEntry = oldManifest.files[p];
    const newEntry = newManifest.files[p];
    if (!oldEntry && newEntry) {
      lines.push(`A ${p}`);
    } else if (oldEntry && !newEntry) {
      lines.push(`D ${p}`);
    } else if (oldEntry && newEntry && oldEntry.hash !== newEntry.hash) {
      lines.push(`M ${p}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "(no changes)";
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
