import { asBoolean, asString, asStringArray } from "../core/json-utils";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import type { SkillCatalogItem, SkillDocument } from "../core/skill-types";

interface LoadedSkillItem {
  name: string;
  description: string;
  frontmatter: SkillDocument["frontmatter"];
  body: string;
  skillDir: string | null;
  skillFile: string | null;
}

export class SkillLoadTool implements Tool {
  readonly definition = {
    name: "skill_load",
    description: "Load one or more skills and return full SKILL.md instructions (Tier 2).",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Single skill name from the skill catalog (legacy)." },
        names: {
          type: "array",
          items: { type: "string" },
          description: "One or more skill names to load in a batch."
        },
        refresh_catalog: {
          type: "boolean",
          description: "Refresh skill catalog before loading (default: true)."
        }
      },
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const runtime = context.skillRuntime;
    if (!runtime) {
      return { ok: false, error: "skill runtime is not configured." };
    }

    const requested = normalizeRequestedSkillNames(input);
    if (requested.error) {
      return { ok: false, error: requested.error };
    }
    if (requested.names.length === 0) {
      return { ok: false, error: "Provide name or names with at least one non-empty skill name." };
    }

    const shouldRefresh = asBoolean(input.refresh_catalog) ?? true;

    try {
      if (shouldRefresh) {
        runtime.refreshCatalog();
      }
      const catalog = runtime.listCatalog();
      const catalogMap = new Map<string, SkillCatalogItem>();
      for (const item of catalog) {
        catalogMap.set(item.name.toLowerCase(), item);
      }

      const skills: LoadedSkillItem[] = [];
      const missing: string[] = [];
      const failed: Array<{ name: string; error: string }> = [];

      for (const name of requested.names) {
        try {
          const doc = runtime.loadSkill(name);
          const catalogItem = catalogMap.get(doc.frontmatter.name.toLowerCase());
          skills.push({
            name: doc.frontmatter.name,
            description: doc.frontmatter.description,
            frontmatter: doc.frontmatter,
            body: doc.body,
            skillDir: catalogItem?.skillDir ?? null,
            skillFile: catalogItem?.skillFile ?? null
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/skill not found/i.test(message)) {
            missing.push(name);
          } else {
            failed.push({ name, error: message });
          }
        }
      }

      const data: Record<string, unknown> = {
        requested: requested.names,
        loadedCount: skills.length,
        skills,
        missing
      };
      if (failed.length > 0) {
        data.failed = failed;
      }

      if (requested.names.length === 1 && skills.length === 1) {
        const single = skills[0];
        data.name = single.name;
        data.description = single.description;
        data.frontmatter = single.frontmatter;
        data.body = single.body;
        data.skillDir = single.skillDir;
        data.skillFile = single.skillFile;
      }

      if (skills.length === 0) {
        return {
          ok: false,
          error:
            failed.length > 0
              ? "Failed to load requested skills."
              : `No requested skills were found: ${requested.names.join(", ")}`,
          data
        };
      }

      return {
        ok: true,
        data
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

function normalizeRequestedSkillNames(input: JsonObject): { names: string[]; error?: string } {
  const output: string[] = [];
  const seen = new Set<string>();

  const single = asString(input.name);
  if (single !== null) {
    const normalized = single.trim();
    if (normalized) {
      const key = normalized.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        output.push(normalized);
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, "names")) {
    const names = asStringArray(input.names);
    if (!names) {
      return { names: [], error: "names must be an array of strings when provided." };
    }
    for (const item of names) {
      const normalized = item.trim();
      if (!normalized) {
        continue;
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      output.push(normalized);
    }
  }

  return { names: output };
}
