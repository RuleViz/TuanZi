import { CoderAgent } from "./agents/coder-agent";
import { OpenAICompatibleClient } from "./agents/openai-compatible-client";
import { PlanToDoOrchestrator } from "./agents/orchestrator";
import { PlannerAgent } from "./agents/planner-agent";
import { SearcherAgent } from "./agents/searcher-agent";
import type { RuntimeConfig } from "./config";
import { ConsoleApprovalGate } from "./core/approval-gate";
import { LocalBackupManager } from "./core/backup-manager";
import { ConsoleLogger } from "./core/logger";
import { ConfigPolicyEngine } from "./core/policy-engine";
import { ToolRegistry } from "./core/tool-registry";
import type { ToolExecutionContext } from "./core/types";
import { McpManager } from "./mcp/manager";
import { createDefaultTools } from "./tools";

export interface ToolRuntime {
  registry: ToolRegistry;
  toolContext: ToolExecutionContext;
  logger: ConsoleLogger;
}

export function createToolRuntime(runtimeConfig: RuntimeConfig): ToolRuntime {
  const logger = new ConsoleLogger();
  const approvalGate = new ConsoleApprovalGate(runtimeConfig.approvalMode);
  const backupManager = new LocalBackupManager(runtimeConfig.workspaceRoot);
  const policyEngine = new ConfigPolicyEngine(runtimeConfig.agentSettings.policy);
  const mcpBridge = new McpManager(runtimeConfig.agentSettings.mcp, logger);
  const registry = new ToolRegistry(createDefaultTools());
  const toolContext: ToolExecutionContext = {
    workspaceRoot: runtimeConfig.workspaceRoot,
    approvalGate,
    backupManager,
    logger,
    policyEngine,
    agentSettings: runtimeConfig.agentSettings,
    mcpBridge
  };
  return { registry, toolContext, logger };
}

export function createOrchestrator(runtimeConfig: RuntimeConfig, toolRuntime: ToolRuntime): PlanToDoOrchestrator {
  const client =
    runtimeConfig.model.apiKey !== null
      ? new OpenAICompatibleClient({
          baseUrl: runtimeConfig.model.baseUrl,
          apiKey: runtimeConfig.model.apiKey
        })
      : null;

  const planner = new PlannerAgent(client, runtimeConfig.model.plannerModel);
  const searcher = new SearcherAgent(client, runtimeConfig.model.searchModel, toolRuntime.registry, toolRuntime.toolContext);
  const coder = new CoderAgent(client, runtimeConfig.model.coderModel, toolRuntime.registry, toolRuntime.toolContext);
  const directModel =
    runtimeConfig.model.coderModel ?? runtimeConfig.model.searchModel ?? runtimeConfig.model.plannerModel ?? null;

  return new PlanToDoOrchestrator(
    planner,
    searcher,
    coder,
    client,
    directModel,
    runtimeConfig.agentSettings.routing,
    toolRuntime.toolContext
  );
}
