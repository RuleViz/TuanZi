import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { CheckpointListPayload, CheckpointUndoPayload } from '../../shared/ipc-contracts'
import type { TurnCheckpointManager } from '../services/turn-checkpoint-manager'

export interface CheckpointHandlersDeps {
  normalizeOptionalString: (input: unknown) => string | null
  toErrorMessage: (error: unknown) => string
  getCheckpointManager: (workspace: string) => TurnCheckpointManager
  rollbackConversationMemoryToCheckpoint: (workspace: string, sessionId: string, checkpointId: string) => Promise<boolean>
  clearResumeSnapshot: () => Promise<void>
}

export async function handleCheckpointUndo(
  deps: CheckpointHandlersDeps,
  payload: CheckpointUndoPayload
): Promise<{ ok: boolean; restoredFiles?: number; removedFiles?: number; error?: string }> {
  try {
    const sessionId = deps.normalizeOptionalString(payload.sessionId)
    const workspace = deps.normalizeOptionalString(payload.workspace)
    const checkpointId = deps.normalizeOptionalString(payload.checkpointId)
    if (!sessionId) {
      return { ok: false, error: 'Session ID is required' }
    }
    if (!workspace) {
      return { ok: false, error: 'Workspace is required' }
    }
    if (!checkpointId) {
      return { ok: false, error: 'Checkpoint ID is required' }
    }
    const mgr = deps.getCheckpointManager(workspace)
    const stats = await mgr.restore(checkpointId)
    if (!stats) {
      return { ok: false, error: 'Failed to restore checkpoint' }
    }
    const rolledBack = await deps.rollbackConversationMemoryToCheckpoint(workspace, sessionId, checkpointId)
    if (!rolledBack) {
      return { ok: false, error: 'Failed to rollback conversation history' }
    }
    await deps.clearResumeSnapshot().catch(() => undefined)
    return { ok: true, restoredFiles: stats.restoredFiles, removedFiles: stats.removedFiles }
  } catch (error) {
    return { ok: false, error: deps.toErrorMessage(error) }
  }
}

export function registerCheckpointHandlers(deps: CheckpointHandlersDeps): void {
  ipcMain.handle(IPC_CHANNELS.checkpointList, async (_event, payload: CheckpointListPayload) => {
    try {
      const workspace = deps.normalizeOptionalString(payload.workspace)
      if (!workspace) {
        return { ok: false, error: 'Workspace is required' }
      }
      const mgr = deps.getCheckpointManager(workspace)
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
    return handleCheckpointUndo(deps, payload)
  })
}
