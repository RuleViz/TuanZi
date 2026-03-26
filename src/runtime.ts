import { TuanZiAgent } from "./agents/tuanzi";
import { OpenAICompatibleClient } from "./agents/openai-compatible-client";
import { PlannerAgent } from "./agents/planner-agent";
import { SubagentExplorerAgent } from "./agents/subagent-explorer";
import { PlanToDoOrchestrator } from "./agents/orchestrator";
import type { RuntimeConfig } from "./config";
import { ConsoleApprovalGate } from "./core/approval-gate";
import { LocalBackupManager } from "./core/backup-manager";
import { ConsoleLogger } from "./core/logger";
import { ConfigPolicyEngine } from "./core/policy-engine";
import { createSkillRuntime } from "./core/skill-store";
import { SubagentManager } from "./core/subagent-manager";
import { ToolRegistry } from "./core/tool-registry";
import type {
  ApprovalGate,
  Logger,
  SubagentBridge,
  SubagentSnapshot,
  TerminalBridge,
  ToolExecutionContext,
  UserInteractionBridge
} from "./core/types";
import { McpManager } from "./mcp/manager";
import { createDefaultTools } from "./tools";

export interface ToolRuntime {
  registry: ToolRegistry;
  toolContext: ToolExecutionContext;
  logger: Logger;
  dispose: () => Promise<void>;
}

export function createToolRuntime(
  runtimeConfig: RuntimeConfig,
  overrides?: { logger?: Logger; approvalGate?: ApprovalGate; terminalBridge?: TerminalBridge; userInteractionBridge?: UserInteractionBridge; sessionId?: string }
): ToolRuntime {
  const logger = overrides?.logger ?? new ConsoleLogger();
  const approvalGate = overrides?.approvalGate ?? new ConsoleApprovalGate(runtimeConfig.approvalMode);
  const backupManager = new LocalBackupManager(runtimeConfig.workspaceRoot);
  const policyEngine = new ConfigPolicyEngine(runtimeConfig.agentSettings.policy);
  const mcpBridge = new McpManager(runtimeConfig.agentSettings.mcp, logger);
  const skillRuntime = createSkillRuntime(runtimeConfig.workspaceRoot, logger);
  const registry = new ToolRegistry(createDefaultTools());
  const toolContext: ToolExecutionContext = {
    workspaceRoot: runtimeConfig.workspaceRoot,
    approvalGate,
    backupManager,
    logger,
    modelTokenBudget: runtimeConfig.model.tokenBudget ?? undefined,
    policyEngine,
    agentSettings: runtimeConfig.agentSettings,
    mcpBridge,
    skillRuntime,
    terminalBridge: overrides?.terminalBridge,
    userInteractionBridge: overrides?.userInteractionBridge,
    sessionId: overrides?.sessionId
  };

  const dispose = async (): Promise<void> => {
    try {
      await mcpBridge.stopAll();
    } catch {
      // Ignore errors during disposal.
    }
  };

  return { registry, toolContext, logger, dispose };
}

export function createOrchestrator(runtimeConfig: RuntimeConfig, toolRuntime: ToolRuntime): PlanToDoOrchestrator {
  const client = createModelClient(runtimeConfig);

  const coder = new TuanZiAgent(
    client,
    runtimeConfig.model.coderModel,
    toolRuntime.registry,
    toolRuntime.toolContext,
    runtimeConfig.agentBackend.activeAgent
  );
  const planner = new PlannerAgent(client, runtimeConfig.model.plannerModel, runtimeConfig.workspaceRoot, toolRuntime.registry, toolRuntime.toolContext);
  return new PlanToDoOrchestrator(coder, planner, toolRuntime.toolContext);
}

export function createSubagentBridge(
  runtimeConfig: RuntimeConfig,
  toolRuntime: ToolRuntime,
  input?: {
    taskId?: string | null;
    onTasksChange?: (tasks: Array<{
      id: string;
      title: string;
      kind: "subagent";
      status: "pending" | "running" | "done" | "failed";
      detail?: string;
    }>) => void;
    onSnapshotsChange?: (snapshots: SubagentSnapshot[]) => void;
  }
): SubagentBridge {
  const client = createModelClient(runtimeConfig);
  const explorer = new SubagentExplorerAgent(
    client,
    runtimeConfig.model.searchModel,
    toolRuntime.registry,
    toolRuntime.toolContext
  );
  return new SubagentManager({
    maxConcurrent: 3,
    taskId: input?.taskId ?? null,
    runExplorer: async ({ task, context, signal }) => explorer.run({ task, context, signal }),
    onSnapshotsChange: (snapshots) => {
      input?.onTasksChange?.(snapshots.map(toWorkbenchTaskItem));
      input?.onSnapshotsChange?.(snapshots);
    }
  });
}

function createModelClient(runtimeConfig: RuntimeConfig): OpenAICompatibleClient | null {
  return runtimeConfig.model.apiKey !== null
    ? new OpenAICompatibleClient({
        baseUrl: runtimeConfig.model.baseUrl,
        apiKey: runtimeConfig.model.apiKey,
        defaultRequestOptions: runtimeConfig.model.requestOptions ?? undefined
      })
    : null;
}

function toWorkbenchTaskItem(snapshot: SubagentSnapshot): {
  id: string;
  title: string;
  kind: "subagent";
  status: "pending" | "running" | "done" | "failed";
  detail?: string;
} {
  return {
    id: snapshot.id,
    title: `Subagent: ${truncate(snapshot.task, 72)}`,
    kind: "subagent",
    status: toWorkbenchStatus(snapshot.status),
    detail: buildTaskDetail(snapshot)
  };
}

function toWorkbenchStatus(status: SubagentSnapshot["status"]): "pending" | "running" | "done" | "failed" {
  if (status === "queued") {
    return "pending";
  }
  if (status === "running") {
    return "running";
  }
  if (status === "completed") {
    return "done";
  }
  return "failed";
}

function buildTaskDetail(snapshot: SubagentSnapshot): string {
  if (snapshot.status === "queued") {
    return "Queued for read-only discovery.";
  }
  if (snapshot.status === "running") {
    return "Collecting evidence in a child context.";
  }
  if (snapshot.status === "completed") {
    return snapshot.result?.summary || "Subagent completed.";
  }
  if (snapshot.status === "cancelled") {
    return snapshot.result?.error || "Cancelled.";
  }
  return snapshot.result?.error || "Subagent failed.";
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(1, maxLength - 3))}...`;
}
