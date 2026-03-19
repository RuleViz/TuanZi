import type { ToolRegistry } from "../core/tool-registry";
import { parseJsonObject } from "../core/json-utils";
import type {
  ExecutionPlan,
  SearchReference,
  SearchResult,
  ToolCallRecord,
  ToolExecutionContext,
  ToolExecutionResult
} from "../core/types";
import type { ChatCompletionClient } from "./model-types";
import { searcherSystemPrompt } from "./prompts";
import { ReactToolAgent, type ToolLoopToolCallSnapshot } from "./react-tool-agent";

const SEARCH_TOOLS = [
  "ls",
  "glob",
  "grep",
  "read"
];

export interface SearcherOutput {
  result: SearchResult;
  toolCalls: ToolCallRecord[];
}

export class SearcherAgent {
  constructor(
    private readonly client: ChatCompletionClient | null,
    private readonly model: string | null,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolContext: ToolExecutionContext
  ) { }

  async search(
    task: string,
    plan: ExecutionPlan,
    conversationContext = "",
    signal?: AbortSignal,
    hooks?: {
      onToolCallCompleted?: (call: ToolLoopToolCallSnapshot) => void;
    }
  ): Promise<SearcherOutput> {
    throwIfAborted(signal);
    if (!this.client || !this.model) {
      return {
        result: await this.fallbackSearch(task, signal),
        toolCalls: []
      };
    }

    const userPromptSections = [
      "Task:",
      task,
      "",
      "Plan (JSON):",
      JSON.stringify(plan, null, 2)
    ];
    if (conversationContext) {
      userPromptSections.push(
        "",
        "Conversation memory from previous turns (context only, lower priority than current task):",
        conversationContext
      );
    }
    userPromptSections.push("", "Find relevant files and return strict JSON.");
    const userPrompt = userPromptSections.join("\n");

    const agent = new ReactToolAgent(this.client, this.model, this.toolRegistry, this.toolContext);
    const maxTurns = this.toolContext.agentSettings?.toolLoop.searchMaxTurns ?? 12;
    const output = await agent.run({
      systemPrompt: searcherSystemPrompt({
        workspaceRoot: this.toolContext.workspaceRoot,
        enabledTools: SEARCH_TOOLS
      }),
      userPrompt,
      allowedTools: SEARCH_TOOLS,
      maxTurns,
      temperature: 0.1,
      onToolCallCompleted: hooks?.onToolCallCompleted,
      signal
    });

    const toolCalls: ToolCallRecord[] = output.toolCalls.map((call) => ({
      toolName: call.name,
      args: call.args,
      result: call.result,
      timestamp: new Date().toISOString()
    }));

    const parsed = parseJsonObject(output.finalText);
    if (!parsed) {
      return {
        result: fallbackSearchFromToolCalls(output.toolCalls, "Model output is not valid JSON; fallback to tool outputs."),
        toolCalls
      };
    }

    const references = Array.isArray(parsed.references)
      ? parsed.references.map(toSearchReference).filter((item): item is SearchReference => item !== null)
      : [];

    const webReferences = Array.isArray(parsed.webReferences)
      ? parsed.webReferences
        .map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return null;
          }
          const record = item as Record<string, unknown>;
          const url = typeof record.url === "string" ? record.url : null;
          const reason = typeof record.reason === "string" ? record.reason : "";
          if (!url) {
            return null;
          }
          return { url, reason };
        })
        .filter((item): item is { url: string; reason: string } => item !== null)
      : [];

    return {
      result: {
        summary: typeof parsed.summary === "string" ? parsed.summary : "Searcher completed.",
        references,
        webReferences
      },
      toolCalls
    };
  }

  private async fallbackSearch(task: string, signal?: AbortSignal): Promise<SearchResult> {
    throwIfAborted(signal);
    const keywords = task
      .split(/[\s,.;!?/\\]+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
      .slice(0, 5);

    const references: SearchReference[] = [];
    for (const keyword of keywords) {
      throwIfAborted(signal);
      const result = await this.toolRegistry.execute(
        "glob",
        {
          search_path: this.toolContext.workspaceRoot,
          pattern: `*${keyword}*`,
          max_results: 8
        },
        this.toolContext
      );
      collectSearchRefsFromFindResult(result, references);
      if (references.length >= 12) {
        break;
      }
    }

    if (references.length === 0) {
      const fallbackPatterns = ["*.ts", "*.js", "*.json", "*.md"];
      for (const pattern of fallbackPatterns) {
        throwIfAborted(signal);
        const fallback = await this.toolRegistry.execute(
          "glob",
          { search_path: this.toolContext.workspaceRoot, pattern, max_results: 8 },
          this.toolContext
        );
        collectSearchRefsFromFindResult(fallback, references);
        if (references.length >= 12) {
          break;
        }
      }
    }

    return {
      summary: "Searcher fallback mode used file-name matching to collect candidate files.",
      references: uniqueByPath(references).slice(0, 20),
      webReferences: []
    };
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Interrupted by user");
  }
}

function toSearchReference(value: unknown): SearchReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : null;
  const reason = typeof record.reason === "string" ? record.reason : "";
  const confidence =
    record.confidence === "low" || record.confidence === "medium" || record.confidence === "high"
      ? record.confidence
      : "medium";
  if (!path) {
    return null;
  }
  return { path, reason, confidence };
}

function fallbackSearchFromToolCalls(
  calls: Array<{ name: string; args: Record<string, unknown>; result: ToolExecutionResult }>,
  summary: string
): SearchResult {
  const references: SearchReference[] = [];
  for (const call of calls) {
    if (call.name !== "glob") {
      continue;
    }
    collectSearchRefsFromFindResult(call.result, references);
  }
  return {
    summary,
    references: uniqueByPath(references).slice(0, 20),
    webReferences: []
  };
}

function collectSearchRefsFromFindResult(result: ToolExecutionResult, references: SearchReference[]): void {
  if (!result.ok || !result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    return;
  }
  const data = result.data as Record<string, unknown>;
  const matches = Array.isArray(data.matches) ? data.matches : [];
  for (const match of matches) {
    if (!match || typeof match !== "object" || Array.isArray(match)) {
      continue;
    }
    const record = match as Record<string, unknown>;
    const absolutePath = typeof record.absolutePath === "string" ? record.absolutePath : null;
    if (!absolutePath) {
      continue;
    }
    references.push({
      path: absolutePath,
      reason: "Matched by file-name search.",
      confidence: "medium"
    });
  }
}

function uniqueByPath(references: SearchReference[]): SearchReference[] {
  const seen = new Set<string>();
  const output: SearchReference[] = [];
  for (const ref of references) {
    if (seen.has(ref.path)) {
      continue;
    }
    seen.add(ref.path);
    output.push(ref);
  }
  return output;
}
