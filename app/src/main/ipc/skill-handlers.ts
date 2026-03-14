import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import type { SkillCatalogItem } from "../../shared/domain-types";

export interface SkillHandlersDeps {
  loadCoreModules: () => any;
  toErrorMessage: (error: unknown) => string;
  collectWorkspaceCandidates: (
    primaryWorkspace?: string | null,
    candidates?: Array<string | null | undefined>
  ) => string[];
  resolveWorkspaceFromInput: (workspace: string | null | undefined) => string;
  disposeRuntimeSafe: (runtime: { dispose?: () => Promise<void> } | null) => Promise<void>;
}

export function registerSkillHandlers(deps: SkillHandlersDeps): void {
  ipcMain.handle(
    IPC_CHANNELS.skillsList,
    async (_event, payload: { workspace?: string | null; workspaceCandidates?: Array<string | null | undefined> }) => {
      const runtimes: Array<{ dispose?: () => Promise<void> }> = [];
      try {
        const { loadRuntimeConfig, createToolRuntime } = deps.loadCoreModules();
        const workspaceCandidates = deps.collectWorkspaceCandidates(payload?.workspace, payload?.workspaceCandidates);
        const skillMap = new Map<string, SkillCatalogItem>();

        for (const workspaceRoot of workspaceCandidates) {
          const runtimeConfig = loadRuntimeConfig({
            workspaceRoot: deps.resolveWorkspaceFromInput(workspaceRoot),
            approvalMode: "auto"
          });
          const runtime = createToolRuntime(runtimeConfig);
          runtimes.push(runtime);
          const skillRuntime = runtime.toolContext?.skillRuntime;
          const skills =
            skillRuntime && typeof skillRuntime.listCatalog === "function" ? skillRuntime.listCatalog() : [];
          for (const skill of skills) {
            const dedupeKey = skill.skillDir.toLowerCase();
            if (!skillMap.has(dedupeKey)) {
              skillMap.set(dedupeKey, skill);
            }
          }
        }

        const skills = [...skillMap.values()].sort((left, right) => left.name.localeCompare(right.name));
        return { ok: true, skills };
      } catch (error) {
        return { ok: false, error: deps.toErrorMessage(error) };
      } finally {
        await Promise.allSettled(runtimes.map((runtime) => deps.disposeRuntimeSafe(runtime)));
      }
    }
  );
}
