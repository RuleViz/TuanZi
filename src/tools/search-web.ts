import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asNumber, asString } from "../core/json-utils";

interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  score: number;
  sourceType: "official" | "github" | "community" | "other";
}

interface CachedSearchEntry {
  expiresAt: number;
  data: Record<string, unknown>;
}

const SEARCH_CACHE = new Map<string, CachedSearchEntry>();
const SEARCH_USAGE_BY_TASK = new Map<string, number>();
const MAX_TRACKED_TASKS = 200;

export class SearchWebTool implements Tool {
  readonly definition = {
    name: "search_web",
    description: "Search the web via MCP tool (preferred) or HTTP fallback providers.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text." },
        max_results: { type: "number", description: "Max result count (1-10)." }
      },
      required: ["query"],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const query = asString(input.query);
    if (!query) {
      return { ok: false, error: "query is required and must be a string." };
    }

    const webSettings = context.agentSettings?.webSearch;
    if (webSettings && !webSettings.enabled) {
      return { ok: false, error: "search_web is disabled by agent.config.json policy." };
    }

    const configuredMax = webSettings?.maxResultsPerUse ?? 5;
    const maxResults = clampInt(asNumber(input.max_results) ?? configuredMax, 1, configuredMax);
    const taskId = context.taskId ?? "default-task";
    const maxUsesPerTask = webSettings?.maxUsesPerTask ?? 2;
    const currentUses = SEARCH_USAGE_BY_TASK.get(taskId) ?? 0;
    if (currentUses >= maxUsesPerTask) {
      return {
        ok: false,
        error: `search_web budget exceeded for this task (maxUsesPerTask=${maxUsesPerTask}).`
      };
    }
    SEARCH_USAGE_BY_TASK.set(taskId, currentUses + 1);
    pruneTaskUsageIfNeeded();

    const provider = webSettings?.provider ?? "mcp";
    if (provider !== "mcp" && provider !== "http") {
      return { ok: false, error: `Unsupported webSearch.provider: ${String(provider)}` };
    }

    const cacheTtlMs = webSettings?.cacheTtlMs ?? 10 * 60 * 1000;
    const cacheKey = `${provider}:${query.trim().toLowerCase()}:${maxResults}`;
    const now = Date.now();
    const cached = SEARCH_CACHE.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return {
        ok: true,
        data: {
          ...cached.data,
          cached: true,
          taskId,
          remainingBudget: Math.max(0, maxUsesPerTask - (currentUses + 1))
        }
      };
    }

    if (provider === "mcp") {
      if (!context.mcpBridge) {
        return {
          ok: false,
          error: "MCP bridge is not available. Configure MCP in runtime."
        };
      }

      const toolName = context.agentSettings?.mcp.tools.webSearch ?? "web_search";
      const callResult = await context.mcpBridge.callTool(toolName, {
        query,
        max_results: maxResults
      });
      const normalizedResults = normalizeMcpResults(callResult, maxResults);
      const payload = {
        provider: "mcp" as const,
        query,
        results: normalizedResults,
        raw: callResult
      };
      SEARCH_CACHE.set(cacheKey, {
        expiresAt: now + cacheTtlMs,
        data: payload
      });
      pruneSearchCache(now);

      return {
        ok: true,
        data: {
          ...payload,
          cached: false,
          taskId,
          remainingBudget: Math.max(0, maxUsesPerTask - (currentUses + 1))
        }
      };
    }

    const httpProvider = resolveHttpProvider();
    if (!httpProvider) {
      return {
        ok: false,
        error: "HTTP web search fallback requires TAVILY_API_KEY or BRAVE_SEARCH_API_KEY."
      };
    }

    const raw = httpProvider === "tavily"
      ? await searchByTavily(query, maxResults, process.env.TAVILY_API_KEY!)
      : await searchByBrave(query, maxResults, process.env.BRAVE_SEARCH_API_KEY!);

    if (!raw.ok) {
      return raw;
    }
    if (!raw.data || typeof raw.data !== "object" || Array.isArray(raw.data)) {
      return { ok: false, error: "search_web provider returned invalid response payload." };
    }

    const data = raw.data as { provider: "tavily" | "brave"; query: string; results: SearchResultItem[] };
    SEARCH_CACHE.set(cacheKey, {
      expiresAt: now + cacheTtlMs,
      data
    });
    pruneSearchCache(now);

    return {
      ok: true,
      data: {
        ...data,
        cached: false,
        taskId,
        remainingBudget: Math.max(0, maxUsesPerTask - (currentUses + 1))
      }
    };
  }
}

function clampInt(value: number, min: number, max: number): number {
  const integer = Math.floor(value);
  return Math.max(min, Math.min(max, integer));
}

function resolveHttpProvider(): "tavily" | "brave" | null {
  if (process.env.TAVILY_API_KEY) {
    return "tavily";
  }
  if (process.env.BRAVE_SEARCH_API_KEY) {
    return "brave";
  }
  return null;
}

function normalizeMcpResults(result: Record<string, unknown>, maxResults: number): SearchResultItem[] {
  const structured = result.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    const records = (structured as Record<string, unknown>).results;
    const normalized = normalizeUnknownResults(records, maxResults);
    if (normalized.length > 0) {
      return scoreAndSortResults(normalized);
    }
  }

  const content = result.content;
  if (Array.isArray(content)) {
    const textParts = content
      .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>).text : null))
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0);

    for (const text of textParts) {
      try {
        const parsed = JSON.parse(text) as unknown;
        const normalized = normalizeUnknownResults(parsed, maxResults);
        if (normalized.length > 0) {
          return scoreAndSortResults(normalized);
        }
      } catch {
        // ignore non-JSON text payloads
      }
    }
  }

  return [];
}

function normalizeUnknownResults(value: unknown, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .slice(0, maxResults)
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const url = typeof record.url === "string" ? record.url : null;
      if (!url || !url.trim()) {
        return null;
      }
      const title = typeof record.title === "string" ? record.title : "";
      const snippet = typeof record.snippet === "string" ? record.snippet : typeof record.content === "string" ? record.content : "";
      return { title, url, snippet };
    })
    .filter((item): item is { title: string; url: string; snippet: string } => item !== null);
}

async function searchByTavily(query: string, maxResults: number, apiKey: string): Promise<ToolExecutionResult> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      max_results: maxResults
    })
  }).catch((error) => {
    throw new Error(`Tavily request failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  if (!response.ok) {
    return { ok: false, error: `Tavily search failed with status ${response.status}.` };
  }

  const payload = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  const results = scoreAndSortResults(
    (payload.results ?? [])
    .slice(0, maxResults)
    .map((item) => ({
      title: item.title ?? "",
      url: item.url ?? "",
      snippet: item.content ?? ""
    }))
    .filter((item) => item.url)
  );

  return {
    ok: true,
    data: {
      provider: "tavily",
      query,
      results
    }
  };
}

async function searchByBrave(query: string, maxResults: number, apiKey: string): Promise<ToolExecutionResult> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));

  const response = await fetch(url, {
    headers: {
      "x-subscription-token": apiKey
    }
  }).catch((error) => {
    throw new Error(`Brave request failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  if (!response.ok) {
    return { ok: false, error: `Brave search failed with status ${response.status}.` };
  }

  const payload = (await response.json()) as {
    web?: {
      results?: Array<{ title?: string; url?: string; description?: string }>;
    };
  };
  const results = (payload.web?.results ?? [])
    .slice(0, maxResults)
    .map((item) => ({
      title: item.title ?? "",
      url: item.url ?? "",
      snippet: item.description ?? ""
    }))
    .filter((item) => item.url);

  return {
    ok: true,
    data: {
      provider: "brave",
      query,
      results: scoreAndSortResults(results)
    }
  };
}

function scoreAndSortResults(items: Array<{ title: string; url: string; snippet: string }>): SearchResultItem[] {
  const scored = items
    .map((item) => {
      const sourceType = classifySource(item.url);
      const score = computeSourceScore(item, sourceType);
      return {
        ...item,
        score,
        sourceType
      };
    })
    .sort((left, right) => right.score - left.score);

  return scored;
}

function classifySource(url: string): "official" | "github" | "community" | "other" {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "other";
  }

  if (host.includes("github.com")) {
    return "github";
  }

  const officialHints = ["docs.", "developer.", "api.", ".gov", ".edu", "readthedocs.io"];
  if (officialHints.some((hint) => host.includes(hint))) {
    return "official";
  }

  const communityHints = ["stackoverflow.com", "medium.com", "dev.to", "reddit.com"];
  if (communityHints.some((hint) => host.includes(hint))) {
    return "community";
  }

  return "other";
}

function computeSourceScore(
  item: { title: string; url: string; snippet: string },
  sourceType: "official" | "github" | "community" | "other"
): number {
  let score = 0.45;

  if (sourceType === "official") {
    score += 0.35;
  } else if (sourceType === "github") {
    score += 0.25;
  } else if (sourceType === "community") {
    score += 0.15;
  }

  const lowerUrl = item.url.toLowerCase();
  if (lowerUrl.includes("/docs") || lowerUrl.includes("/reference") || lowerUrl.includes("/releases")) {
    score += 0.1;
  }
  if (item.snippet.length >= 100) {
    score += 0.05;
  }
  if (item.title.trim().length > 0) {
    score += 0.03;
  }

  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

function pruneSearchCache(nowMs: number): void {
  for (const [key, value] of SEARCH_CACHE.entries()) {
    if (value.expiresAt <= nowMs) {
      SEARCH_CACHE.delete(key);
    }
  }
  if (SEARCH_CACHE.size <= 500) {
    return;
  }
  const overflow = SEARCH_CACHE.size - 500;
  const keys = SEARCH_CACHE.keys();
  for (let index = 0; index < overflow; index += 1) {
    const next = keys.next();
    if (next.done) {
      break;
    }
    SEARCH_CACHE.delete(next.value);
  }
}

function pruneTaskUsageIfNeeded(): void {
  if (SEARCH_USAGE_BY_TASK.size <= MAX_TRACKED_TASKS) {
    return;
  }
  const overflow = SEARCH_USAGE_BY_TASK.size - MAX_TRACKED_TASKS;
  const keys = SEARCH_USAGE_BY_TASK.keys();
  for (let index = 0; index < overflow; index += 1) {
    const next = keys.next();
    if (next.done) {
      break;
    }
    SEARCH_USAGE_BY_TASK.delete(next.value);
  }
}
