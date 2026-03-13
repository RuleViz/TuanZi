import { asString } from "../core/json-utils";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";

export class SkillReadResourceTool implements Tool {
  readonly definition = {
    name: "skill_read_resource",
    description: "Read a text resource from skill scripts/references/assets (Tier 3).",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name from the skill catalog." },
        relative_path: { type: "string", description: "Relative resource path under scripts/references/assets." },
        path: { type: "string", description: "Alias for relative_path." }
      },
      required: ["name"],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const name = asString(input.name)?.trim();
    if (!name) {
      return { ok: false, error: "name is required and must be a non-empty string." };
    }
    const relativePath = asString(input.relative_path)?.trim() ?? asString(input.path)?.trim();
    if (!relativePath) {
      return { ok: false, error: "relative_path is required and must be a non-empty string." };
    }

    const runtime = context.skillRuntime;
    if (!runtime) {
      return { ok: false, error: "skill runtime is not configured." };
    }

    try {
      const resource = runtime.readSkillResource(name, relativePath);
      return {
        ok: true,
        data: {
          name,
          relativePath,
          path: resource.path,
          content: resource.content
        }
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
