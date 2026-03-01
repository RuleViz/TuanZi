import { promises as fs } from "node:fs";
import path from "node:path";
import { assertInsideWorkspace, relativeFromWorkspace } from "./path-utils";
import type { BackupManager } from "./types";

export class LocalBackupManager implements BackupManager {
  private readonly backupRoot: string;

  constructor(private readonly workspaceRoot: string) {
    this.backupRoot = path.join(this.workspaceRoot, ".mycoderagent", "backups");
  }

  async backupFile(absoluteFilePath: string): Promise<string | null> {
    assertInsideWorkspace(absoluteFilePath, this.workspaceRoot);

    const fileStat = await fs.stat(absoluteFilePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      return null;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const relativePath = relativeFromWorkspace(absoluteFilePath, this.workspaceRoot);
    const backupPath = path.join(this.backupRoot, timestamp, relativePath);
    const backupDir = path.dirname(backupPath);

    await fs.mkdir(backupDir, { recursive: true });
    await fs.copyFile(absoluteFilePath, backupPath);

    return backupPath;
  }
}
