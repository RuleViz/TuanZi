import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asString } from "../core/json-utils";

export class SpawnSubagentTool implements Tool {
  readonly definition = {
    name: "spawn_subagent",
    description: "Spawn a read-only explorer subagent for repo search or lightweight web research.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The sub-task to delegate. Best for search, file discovery, and evidence gathering."
        },
        context: {
          type: "string",
          description: "Optional focused context for the subagent. Keep this concise."
        },
        agentType: {
          type: "string",
          enum: ["explorer"],
          description: "Subagent role. v1 supports explorer only."
        }
      },
      required: ["task"],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const bridge = context.subagentBridge;
    if (!bridge) {
      return { ok: false, error: "Subagent bridge is not available in the current runtime." };
    }

    const task = asString(input.task)?.trim();
    if (!task) {
      return { ok: false, error: "task is required and must be a non-empty string." };
    }

    const spawned = await bridge.spawn({
      task,
      ...(typeof input.context === "string" ? { context: input.context } : {}),
      ...(input.agentType === "explorer" ? { agentType: "explorer" as const } : {})
    });
    return {
      ok: true,
      data: spawned
    };
  }
}
