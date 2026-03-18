export type ActiveTaskStatus = "running" | "stopping";

export interface ActiveTaskEntry {
  taskId: string;
  sessionId: string;
  workspace: string;
  controller: AbortController;
  status: ActiveTaskStatus;
  startedAt: number;
  stopRequestedAt: number | null;
  forceStop?: (() => Promise<void>) | null;
}
