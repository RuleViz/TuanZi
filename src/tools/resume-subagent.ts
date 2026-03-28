import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asString } from "../core/json-utils";

export class ResumeSubagentTool implements Tool {
  readonly definition = {
    name: "resume_subagent",
    description: "Resume a previously completed or interrupted read-only explorer subagent from its saved snapshot.",
    parameters: {
      type: "object",
      properties: {
        snapshotId: {
          type: "string",
          description: "Snapshot id of the prior subagent run. v1 uses the original subagent id."
        },
        task: {
          type: "string",
          description: "Follow-up task for the resumed subagent."
        },
        context: {
          type: "string",
          description: "Optional focused context for the resumed subagent."
        },
        agentType: {
          type: "string",
          enum: ["explorer"],
          description: "Subagent role. v1 supports explorer only."
        }
      },
      required: ["snapshotId", "task"],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const bridge = context.subagentBridge;
    if (!bridge) {
      return { ok: false, error: "Subagent bridge is not available in the current runtime." };
    }

    const snapshotId = asString(input.snapshotId)?.trim();
    const task = asString(input.task)?.trim();
    if (!snapshotId) {
      return { ok: false, error: "snapshotId is required and must be a non-empty string." };
    }
    if (!task) {
      return { ok: false, error: "task is required and must be a non-empty string." };
    }

    const resumed = await bridge.resume({
      snapshotId,
      task,
      ...(typeof input.context === "string" ? { context: input.context } : {}),
      ...(input.agentType === "explorer" ? { agentType: "explorer" as const } : {})
    });
    return {
      ok: true,
      data: resumed
    };
  }
}
