import { TuanZiAgent } from "./agents/tuanzi";
import { OpenAICompatibleClient } from "./agents/openai-compatible-client";
import { PlannerAgent } from "./agents/planner-agent";
import { SearcherAgent } from "./agents/searcher-agent";
import { PlanToDoOrchestrator } from "./agents/orchestrator";
import type { RuntimeConfig } from "./config";
import { ConsoleApprovalGate } from "./core/approval-gate";
import { LocalBackupManager } from "./core/backup-manager";
import { ConsoleLogger } from "./core/logger";
import { ConfigPolicyEngine } from "./core/policy-engine";
import { createSkillRuntime } from "./core/skill-store";
import { ToolRegistry } from "./core/tool-registry";
import type { ApprovalGate, Logger, ToolExecutionContext } from "./core/types";
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
  overrides?: { logger?: Logger; approvalGate?: ApprovalGate }
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
    policyEngine,
    agentSettings: runtimeConfig.agentSettings,
    mcpBridge,
    skillRuntime
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
  const client =
    runtimeConfig.model.apiKey !== null
      ? new OpenAICompatibleClient({
          baseUrl: runtimeConfig.model.baseUrl,
          apiKey: runtimeConfig.model.apiKey,
          defaultRequestOptions: runtimeConfig.model.requestOptions ?? undefined
        })
      : null;

  const coder = new TuanZiAgent(
    client,
    runtimeConfig.model.coderModel,
    toolRuntime.registry,
    toolRuntime.toolContext,
    runtimeConfig.agentBackend.activeAgent
  );
  const planner = new PlannerAgent(client, runtimeConfig.model.plannerModel, runtimeConfig.workspaceRoot);
  const searcher = new SearcherAgent(client, runtimeConfig.model.searchModel, toolRuntime.registry, toolRuntime.toolContext);
  return new PlanToDoOrchestrator(coder, planner, searcher, toolRuntime.toolContext);
}
