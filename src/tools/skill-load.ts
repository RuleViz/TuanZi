import { asString } from "../core/json-utils";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";

export class SkillLoadTool implements Tool {
  readonly definition = {
    name: "skill_load",
    description: "Load a skill by name and return full SKILL.md instructions (Tier 2).",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name from the skill catalog." }
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

    const runtime = context.skillRuntime;
    if (!runtime) {
      return { ok: false, error: "skill runtime is not configured." };
    }

    try {
      const doc = runtime.loadSkill(name);
      const catalogItem = runtime
        .listCatalog()
        .find((item) => item.name.toLowerCase() === doc.frontmatter.name.toLowerCase());
      return {
        ok: true,
        data: {
          name: doc.frontmatter.name,
          description: doc.frontmatter.description,
          frontmatter: doc.frontmatter,
          body: doc.body,
          skillDir: catalogItem?.skillDir ?? null,
          skillFile: catalogItem?.skillFile ?? null
        }
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
