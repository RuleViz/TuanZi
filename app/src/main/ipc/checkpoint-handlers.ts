import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { CheckpointListPayload, CheckpointUndoPayload } from '../../shared/ipc-contracts'
import { TurnCheckpointManager } from '../services/turn-checkpoint-manager'

export interface CheckpointHandlersDeps {
  normalizeOptionalString: (input: unknown) => string | null
  toErrorMessage: (error: unknown) => string
}

interface TurnCheckpointManagerLike {
  list(): Promise<Array<{
    id: string
    turnIndex: number
    userMessage: string
    createdAt: string
    toolCalls: string[]
  }>>
  restore(turnId: string): Promise<{ restoredFiles: number; removedFiles: number } | null>
}

const managers = new Map<string, TurnCheckpointManagerLike>()

function getManager(workspace: string): TurnCheckpointManagerLike {
  const key = workspace.toLowerCase()
  const existing = managers.get(key)
  if (existing) {
    return existing
  }

  const logger = {
    info: (msg: string): void => { console.log(`[checkpoint] ${msg}`) },
    warn: (msg: string): void => { console.warn(`[checkpoint] ${msg}`) },
    error: (msg: string): void => { console.error(`[checkpoint] ${msg}`) }
  }

  const mgr = new TurnCheckpointManager(workspace, logger) as TurnCheckpointManagerLike
  managers.set(key, mgr)
  return mgr
}

export function registerCheckpointHandlers(deps: CheckpointHandlersDeps): void {
  ipcMain.handle(IPC_CHANNELS.checkpointList, async (_event, payload: CheckpointListPayload) => {
    try {
      const workspace = deps.normalizeOptionalString(payload.workspace)
      if (!workspace) {
        return { ok: false, error: 'Workspace is required' }
      }
      const mgr = getManager(workspace)
      const checkpoints = await mgr.list()
      return {
        ok: true,
        checkpoints: checkpoints.map((cp) => ({
          id: cp.id,
          turnIndex: cp.turnIndex,
          userMessage: cp.userMessage,
          createdAt: cp.createdAt,
          toolCalls: cp.toolCalls
        }))
      }
    } catch (error) {
      return { ok: false, error: deps.toErrorMessage(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.checkpointUndo, async (_event, payload: CheckpointUndoPayload) => {
    try {
      const workspace = deps.normalizeOptionalString(payload.workspace)
      const checkpointId = deps.normalizeOptionalString(payload.checkpointId)
      if (!workspace) {
        return { ok: false, error: 'Workspace is required' }
      }
      if (!checkpointId) {
        return { ok: false, error: 'Checkpoint ID is required' }
      }
      const mgr = getManager(workspace)
      const stats = await mgr.restore(checkpointId)
      if (!stats) {
        return { ok: false, error: 'Failed to restore checkpoint' }
      }
      return { ok: true, restoredFiles: stats.restoredFiles, removedFiles: stats.removedFiles }
    } catch (error) {
      return { ok: false, error: deps.toErrorMessage(error) }
    }
  })
}
