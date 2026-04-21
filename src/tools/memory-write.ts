import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult, DeclarativeMemoryService } from "../core/types";
import { asString } from "../core/json-utils";
import type { MemoryScope } from "../memory/declarative-store";

const VALID_SCOPES: MemoryScope[] = ["global", "project"];
const VALID_IMPORTANCE = ["high", "medium", "low"];

/**
 * Agent tool: write important information to long-term memory (MEMORY.md).
 *
 * Follows the Hermes Agent pattern of using Markdown files as declarative memory.
 * The store is injected so tests and callers can control the storage location.
 */
export class MemoryWriteTool implements Tool {
  readonly definition = {
    name: "memory_write",
    description:
      "Write important information to long-term memory (MEMORY.md). " +
      "Only save reusable user preferences, project conventions, or key facts. " +
      "Do NOT save temporary information, API keys, passwords, or secrets.",
    destructive: false,
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The information to remember (concise Markdown bullet format)."
        },
        scope: {
          type: "string",
          enum: VALID_SCOPES,
          description:
            "global = cross-project user preferences; project = conventions for this specific project."
        },
        importance: {
          type: "string",
          enum: VALID_IMPORTANCE,
          description:
            "high = core preference, GC-exempt (prefix with ⭐ automatically); " +
            "medium = normal knowledge (default); low = temporary info, decays faster."
        }
      },
      required: ["content", "scope"],
      additionalProperties: false
    }
  } as const;

  constructor(private readonly store: DeclarativeMemoryService) {}

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const content = asString(input.content);
    const scopeRaw = asString(input.scope);
    const importanceRaw = asString(input.importance) ?? "medium";

    if (!content || content.trim().length === 0) {
      return { ok: false, error: "content is required and must be a non-empty string." };
    }

    if (!scopeRaw || !VALID_SCOPES.includes(scopeRaw as MemoryScope)) {
      return {
        ok: false,
        error: `scope must be one of: ${VALID_SCOPES.join(", ")}. Got: ${scopeRaw ?? "(missing)"}`
      };
    }

    if (!VALID_IMPORTANCE.includes(importanceRaw)) {
      return {
        ok: false,
        error: `importance must be one of: ${VALID_IMPORTANCE.join(", ")}.`
      };
    }

    const scope = scopeRaw as MemoryScope;

    // Prefix high-importance entries with ⭐ so pruning LLMs can easily identify them.
    const formattedContent = importanceRaw === "high"
      ? content.replace(/^(-\s*)/, "$1⭐ ").replace(/^(?!-)/, "⭐ ")
      : content;

    this.store.appendToMemory(formattedContent, scope, context.workspaceRoot);

    return {
      ok: true,
      data: {
        scope,
        importance: importanceRaw,
        written: formattedContent
      }
    };
  }
}
