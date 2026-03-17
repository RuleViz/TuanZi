import { spawn } from 'node:child_process'
import { type Dirent, promises as fs } from 'node:fs'
import path from 'node:path'

interface CheckpointLogger {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

export interface TurnCheckpoint {
  id: string
  turnIndex: number
  commitHash: string
  userMessage: string
  createdAt: string
  toolCalls: string[]
}

interface TurnCheckpointIndex {
  version: 1
  workspaceRoot: string
  checkpoints: TurnCheckpoint[]
}

const SHADOW_DIR_NAME = 'turn-checkpoints'
const INDEX_FILE_NAME = 'checkpoints.json'
const MAX_CHECKPOINTS_DEFAULT = 50
const MESSAGE_PREVIEW_LENGTH = 200

const SYNC_EXCLUDES = [
  '.git',
  '.tuanzi',
  'node_modules',
  '.npm-cache',
  '.tmp',
  'dist',
  'tmp',
  '.mycoderagent'
]

export class TurnCheckpointManager {
  private readonly shadowRoot: string
  private readonly workspaceRoot: string
  private readonly logger: CheckpointLogger
  private readonly maxCheckpoints: number
  private initialized = false

  constructor(workspaceRoot: string, logger: CheckpointLogger, maxCheckpoints?: number) {
    this.workspaceRoot = workspaceRoot
    this.shadowRoot = path.join(workspaceRoot, '.tuanzi', SHADOW_DIR_NAME)
    this.logger = logger
    this.maxCheckpoints = maxCheckpoints ?? MAX_CHECKPOINTS_DEFAULT
  }

  async createCheckpoint(turnId: string, turnIndex: number, userMessage: string): Promise<TurnCheckpoint | null> {
    try {
      await this.ensureInitialized()
      await this.syncWorkspaceToShadow()

      const addResult = await this.runGit(['add', '-A'], this.shadowRoot)
      if (!addResult.ok) {
        this.logger.warn(`Checkpoint git add failed: ${addResult.stderr.trim()}`)
        return null
      }

      const statusResult = await this.runGit(['status', '--porcelain'], this.shadowRoot)
      if (statusResult.ok && !statusResult.stdout.trim()) {
        const index = await this.loadIndex()
        const last = index.checkpoints[index.checkpoints.length - 1]
        if (last) {
          return last
        }
      }

      const preview = truncateMessage(userMessage, MESSAGE_PREVIEW_LENGTH)
      const message = `turn-${turnIndex}: ${preview}`
      const commitResult = await this.runGit(['commit', '-m', message, '--allow-empty'], this.shadowRoot)
      if (!commitResult.ok) {
        this.logger.warn(`Checkpoint commit failed: ${commitResult.stderr.trim()}`)
        return null
      }

      const hashResult = await this.runGit(['rev-parse', 'HEAD'], this.shadowRoot)
      if (!hashResult.ok) {
        this.logger.warn(`Checkpoint rev-parse failed: ${hashResult.stderr.trim()}`)
        return null
      }

      const checkpoint: TurnCheckpoint = {
        id: turnId,
        turnIndex,
        commitHash: hashResult.stdout.trim(),
        userMessage: preview,
        createdAt: new Date().toISOString(),
        toolCalls: []
      }

      const index = await this.loadIndex()
      index.checkpoints.push(checkpoint)
      await this.pruneIfNeeded(index)
      await this.saveIndex(index)
      return checkpoint
    } catch (error) {
      this.logger.warn(`Failed to create checkpoint: ${toErrorMessage(error)}`)
      return null
    }
  }

  async updateCheckpointToolCalls(turnId: string, toolCalls: string[]): Promise<void> {
    try {
      const index = await this.loadIndex()
      const checkpoint = index.checkpoints.find((cp) => cp.id === turnId)
      if (checkpoint) {
        checkpoint.toolCalls = toolCalls
        await this.saveIndex(index)
      }
    } catch {
      // Non-critical and safe to ignore.
    }
  }

  async restore(turnId: string): Promise<{ restoredFiles: number; removedFiles: number } | null> {
    try {
      const index = await this.loadIndex()
      const checkpoint = index.checkpoints.find((cp) => cp.id === turnId)
      if (!checkpoint) {
        return null
      }

      const checkoutResult = await this.runGit(['checkout', checkpoint.commitHash, '--', '.'], this.shadowRoot)
      if (!checkoutResult.ok) {
        this.logger.error(`Checkpoint restore checkout failed: ${checkoutResult.stderr.trim()}`)
        return null
      }

      const cleanResult = await this.runGit(['clean', '-fd'], this.shadowRoot)
      if (!cleanResult.ok) {
        this.logger.warn(`Checkpoint restore clean warning: ${cleanResult.stderr.trim()}`)
      }

      const stats = await this.syncShadowToWorkspace()
      const cpIndex = index.checkpoints.findIndex((cp) => cp.id === turnId)
      if (cpIndex >= 0) {
        index.checkpoints.splice(cpIndex + 1)
        await this.saveIndex(index)
      }

      await this.runGit(['reset', '--hard', checkpoint.commitHash], this.shadowRoot)
      return stats
    } catch (error) {
      this.logger.error(`Failed to restore checkpoint: ${toErrorMessage(error)}`)
      return null
    }
  }

  async list(): Promise<TurnCheckpoint[]> {
    try {
      const index = await this.loadIndex()
      return [...index.checkpoints]
    } catch {
      return []
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return
    }

    await fs.mkdir(this.shadowRoot, { recursive: true })
    const gitDir = path.join(this.shadowRoot, '.git')
    const gitDirExists = await fs.stat(gitDir).then((s) => s.isDirectory()).catch(() => false)

    if (!gitDirExists) {
      const initResult = await this.runGit(['init'], this.shadowRoot)
      if (!initResult.ok) {
        throw new Error(`Shadow git init failed: ${initResult.stderr.trim()}`)
      }

      const gitignorePath = path.join(this.shadowRoot, '.gitignore')
      await fs.writeFile(gitignorePath, '', 'utf8')
      await this.runGit(['config', 'user.name', 'TuanZi-Checkpoint'], this.shadowRoot)
      await this.runGit(['config', 'user.email', 'checkpoint@tuanzi.local'], this.shadowRoot)
      await this.runGit(['add', '-A'], this.shadowRoot)
      await this.runGit(['commit', '-m', 'init', '--allow-empty'], this.shadowRoot)
    }

    this.initialized = true
  }

  private async syncWorkspaceToShadow(): Promise<void> {
    await syncDirectory(this.workspaceRoot, this.shadowRoot, SYNC_EXCLUDES)
  }

  private async syncShadowToWorkspace(): Promise<{ restoredFiles: number; removedFiles: number }> {
    const stats = { restoredFiles: 0, removedFiles: 0 }

    const shadowFiles = await collectFiles(this.shadowRoot, SYNC_EXCLUDES.concat(['.git']))
    for (const relPath of shadowFiles) {
      const src = path.join(this.shadowRoot, relPath)
      const dest = path.join(this.workspaceRoot, relPath)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.copyFile(src, dest)
      stats.restoredFiles += 1
    }

    const shadowSet = new Set(shadowFiles.map((filePath) => normalizePath(filePath)))
    const workspaceFiles = await collectFiles(this.workspaceRoot, SYNC_EXCLUDES.concat(['.git']))
    for (const relPath of workspaceFiles) {
      if (!shadowSet.has(normalizePath(relPath))) {
        const target = path.join(this.workspaceRoot, relPath)
        await fs.rm(target, { force: true }).catch(() => undefined)
        stats.removedFiles += 1
      }
    }

    if (stats.removedFiles > 0) {
      await removeEmptyDirs(this.workspaceRoot, SYNC_EXCLUDES.concat(['.git']))
    }

    return stats
  }

  private async loadIndex(): Promise<TurnCheckpointIndex> {
    const indexPath = path.join(this.workspaceRoot, '.tuanzi', INDEX_FILE_NAME)
    try {
      const content = await fs.readFile(indexPath, 'utf8')
      const parsed = JSON.parse(content) as unknown
      if (isValidIndex(parsed)) {
        return parsed
      }
    } catch {
      // Missing or invalid index falls back to a fresh one.
    }

    return {
      version: 1,
      workspaceRoot: this.workspaceRoot,
      checkpoints: []
    }
  }

  private async saveIndex(index: TurnCheckpointIndex): Promise<void> {
    const indexPath = path.join(this.workspaceRoot, '.tuanzi', INDEX_FILE_NAME)
    await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  }

  private async pruneIfNeeded(index: TurnCheckpointIndex): Promise<void> {
    if (index.checkpoints.length <= this.maxCheckpoints) {
      return
    }
    const excess = index.checkpoints.length - this.maxCheckpoints
    index.checkpoints.splice(0, excess)
  }

  private runGit(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn('git', args, { cwd, shell: false, env: process.env })
      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += String(chunk)
      })
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += String(chunk)
      })
      child.on('close', (code) => {
        resolve({ ok: code === 0, stdout, stderr })
      })
      child.on('error', (error) => {
        resolve({ ok: false, stdout, stderr: `${stderr}${stderr ? '\n' : ''}${error.message}` })
      })
    })
  }
}

function truncateMessage(message: string, maxLength: number): string {
  const singleLine = message.replace(/\r?\n/g, ' ').trim()
  if (singleLine.length <= maxLength) {
    return singleLine
  }
  return `${singleLine.slice(0, maxLength)}...`
}

function isValidIndex(value: unknown): value is TurnCheckpointIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return record.version === 1 && Array.isArray(record.checkpoints)
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

function shouldExclude(relativePath: string, excludes: string[]): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/')
  for (const part of parts) {
    for (const exclude of excludes) {
      if (exclude.startsWith('*.')) {
        if (part.endsWith(exclude.slice(1))) {
          return true
        }
      } else if (part === exclude) {
        return true
      }
    }
  }
  return false
}

async function collectFiles(rootDir: string, excludes: string[]): Promise<string[]> {
  const results: string[] = []

  async function walk(dir: string, rel: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name
      if (shouldExclude(entryRel, excludes)) {
        continue
      }
      const entryAbs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(entryAbs, entryRel)
      } else if (entry.isFile()) {
        results.push(entryRel)
      }
    }
  }

  await walk(rootDir, '')
  return results
}

async function syncDirectory(src: string, dest: string, excludes: string[]): Promise<void> {
  const files = await collectFiles(src, excludes)
  for (const relPath of files) {
    const srcFile = path.join(src, relPath)
    const destFile = path.join(dest, relPath)
    await fs.mkdir(path.dirname(destFile), { recursive: true })

    const srcContent = await fs.readFile(srcFile).catch(() => null)
    if (srcContent === null) {
      continue
    }
    const destContent = await fs.readFile(destFile).catch(() => null)
    if (destContent !== null && srcContent.equals(destContent)) {
      continue
    }
    await fs.writeFile(destFile, srcContent)
  }

  const srcSet = new Set(files.map((filePath) => normalizePath(filePath)))
  const destFiles = await collectFiles(dest, excludes.concat(['.git']))
  for (const relPath of destFiles) {
    if (relPath === INDEX_FILE_NAME) {
      continue
    }
    if (!srcSet.has(normalizePath(relPath))) {
      const target = path.join(dest, relPath)
      await fs.rm(target, { force: true }).catch(() => undefined)
    }
  }
}

async function removeEmptyDirs(rootDir: string, excludes: string[]): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    if (shouldExclude(entry.name, excludes)) {
      continue
    }
    const dirPath = path.join(rootDir, entry.name)
    await removeEmptyDirs(dirPath, excludes)
    const remaining = await fs.readdir(dirPath).catch(() => ['placeholder'])
    if (remaining.length === 0) {
      await fs.rmdir(dirPath).catch(() => undefined)
    }
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
