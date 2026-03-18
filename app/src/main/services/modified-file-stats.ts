import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ModifiedFileEntry } from "../../shared/ipc-contracts";

const execFileAsync = promisify(execFile);

export async function computeModifiedFileEntries(workspace: string, files: string[]): Promise<ModifiedFileEntry[]> {
  if (files.length === 0) {
    return [];
  }

  const uniqueFiles = [...new Set(files.map((file) => normalizeRelativePath(workspace, file)))].filter(Boolean);
  if (uniqueFiles.length === 0) {
    return [];
  }

  const insideGit = await isGitWorkspace(workspace);
  const counts = new Map<string, { added: number; removed: number }>();

  if (insideGit) {
    await applyGitNumstat(counts, workspace, ["diff", "--numstat", "--", ...uniqueFiles]);
    await applyGitNumstat(counts, workspace, ["diff", "--cached", "--numstat", "--", ...uniqueFiles]);
    const untracked = await readUntrackedFiles(workspace, uniqueFiles);
    for (const file of untracked) {
      const lines = await countFileLines(path.join(workspace, file));
      counts.set(file, { added: lines, removed: 0 });
    }
  }

  const output: ModifiedFileEntry[] = [];
  for (const file of uniqueFiles) {
    const existing = counts.get(file);
    if (existing) {
      output.push({ path: file, added: existing.added, removed: existing.removed });
      continue;
    }
    const absolute = path.join(workspace, file);
    const lines = await countFileLines(absolute);
    output.push({ path: file, added: lines, removed: 0 });
  }

  output.sort((a, b) => a.path.localeCompare(b.path));
  return output;
}

async function isGitWorkspace(workspace: string): Promise<boolean> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: workspace });
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function applyGitNumstat(
  counts: Map<string, { added: number; removed: number }>,
  workspace: string,
  args: string[]
): Promise<void> {
  try {
    const result = await execFileAsync("git", args, { cwd: workspace });
    const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      const [addedRaw, removedRaw, ...fileParts] = line.split(/\s+/);
      const file = fileParts.join(" ");
      if (!file) {
        continue;
      }
      const key = normalizeRelativePath(workspace, file);
      const current = counts.get(key) ?? { added: 0, removed: 0 };
      current.added += parseNumstatValue(addedRaw);
      current.removed += parseNumstatValue(removedRaw);
      counts.set(key, current);
    }
  } catch {
    return;
  }
}

async function readUntrackedFiles(workspace: string, files: string[]): Promise<string[]> {
  try {
    const result = await execFileAsync("git", ["status", "--porcelain", "--", ...files], { cwd: workspace });
    const output = result.stdout.split(/\r?\n/).filter(Boolean);
    return output
      .filter((line) => line.startsWith("?? "))
      .map((line) => normalizeRelativePath(workspace, line.slice(3).trim()));
  } catch {
    return [];
  }
}

function parseNumstatValue(value: string | undefined): number {
  if (!value || value === "-") {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRelativePath(workspace: string, filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").trim();
  if (!normalized) {
    return "";
  }
  if (path.isAbsolute(normalized)) {
    return path.relative(workspace, normalized).replace(/\\/g, "/");
  }
  return normalized;
}

async function countFileLines(filePath: string): Promise<number> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    if (!content) {
      return 0;
    }
    return content.split(/\r?\n/).length;
  } catch {
    return 0;
  }
}
