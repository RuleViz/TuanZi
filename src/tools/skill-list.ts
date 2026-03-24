import { asBoolean, asString, asStringArray } from "../core/json-utils";
import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";

export class SkillListTool implements Tool {
  readonly definition = {
    name: "skill_list",
    description: "List available skills from the runtime catalog (Tier 1).",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description: "Optional exact skill names to include."
        },
        query: {
          type: "string",
          description: "Optional case-insensitive substring filter on skill name/description."
        },
        refresh_catalog: {
          type: "boolean",
          description: "Refresh skill catalog before listing (default: true)."
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

    if (Object.prototype.hasOwnProperty.call(input, "names") && !asStringArray(input.names)) {
      return { ok: false, error: "names must be an array of strings when provided." };
    }

    const shouldRefresh = asBoolean(input.refresh_catalog) ?? true;
    const requestedNames = normalizeRequestedNames(asStringArray(input.names) ?? []);
    const query = asString(input.query)?.trim().toLowerCase() ?? "";

    try {
      if (shouldRefresh) {
        runtime.refreshCatalog();
      }

      const catalog = runtime.listCatalog();
      const byName = new Map<string, (typeof catalog)[number]>();
      for (const skill of catalog) {
        byName.set(skill.name.toLowerCase(), skill);
      }

      let selected = catalog;
      const missing: string[] = [];
      if (requestedNames.length > 0) {
        const requestedSet = new Set(requestedNames.map((name) => name.toLowerCase()));
        selected = catalog.filter((item) => requestedSet.has(item.name.toLowerCase()));
        for (const requested of requestedNames) {
          if (!byName.has(requested.toLowerCase())) {
            missing.push(requested);
          }
        }
      }

      if (query) {
        selected = selected.filter((item) => {
          const name = item.name.toLowerCase();
          const description = item.description.toLowerCase();
          return name.includes(query) || description.includes(query);
        });
      }

      return {
        ok: true,
        data: {
          totalAvailable: catalog.length,
          returned: selected.length,
          requested: requestedNames,
          missing,
          query: query || null,
          skills: selected.map((item) => ({
            name: item.name,
            description: item.description,
            skillDir: item.skillDir,
            skillFile: item.skillFile
          }))
        }
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

function normalizeRequestedNames(input: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    const normalized = value.trim();
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
  return output;
}
