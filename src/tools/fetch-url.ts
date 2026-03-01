import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { asNumber, asString } from "../core/json-utils";

const DEFAULT_MAX_CHARS = 20000;

export class FetchUrlTool implements Tool {
  readonly definition = {
    name: "fetch_url",
    description: "Fetch remote URL content and return cleaned text/markdown-like content.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "http/https URL to fetch." },
        max_chars: { type: "number", description: "Maximum returned characters (1000-200000)." }
      },
      required: ["url"],
      additionalProperties: false
    }
  };

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const url = asString(input.url);
    if (!url) {
      return { ok: false, error: "url is required and must be a string." };
    }

    if (context.agentSettings?.webSearch.provider === "mcp" && context.mcpBridge) {
      const toolName = context.agentSettings.mcp.tools.fetchUrl;
      const pageCharLimit = context.agentSettings?.webSearch.maxCharsPerPage ?? DEFAULT_MAX_CHARS;
      const requestedMaxChars = asNumber(input.max_chars) ?? pageCharLimit;
      const maxChars = clampInt(requestedMaxChars, 1000, pageCharLimit);
      const result = await context.mcpBridge.callTool(toolName, {
        url,
        max_chars: maxChars
      });
      return {
        ok: true,
        data: {
          provider: "mcp",
          tool: toolName,
          url,
          result
        }
      };
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: "Invalid URL." };
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "Only http/https URLs are supported." };
    }

    const pageCharLimit = context.agentSettings?.webSearch.maxCharsPerPage ?? DEFAULT_MAX_CHARS;
    const requestedMaxChars = asNumber(input.max_chars) ?? pageCharLimit;
    const maxChars = clampInt(requestedMaxChars, 1000, pageCharLimit);

    const response = await fetch(parsed, {
      headers: {
        "user-agent": "MyCoderAgent/0.1 (MVP)"
      }
    }).catch((error) => {
      throw new Error(`Network request failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    if (!response.ok) {
      return { ok: false, error: `Fetch failed with status ${response.status}.` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const rawText = await response.text();

    let cleaned = rawText;
    if (contentType.includes("text/html")) {
      cleaned = htmlToText(rawText);
    } else if (contentType.includes("application/json")) {
      try {
        cleaned = JSON.stringify(JSON.parse(rawText), null, 2);
      } catch {
        cleaned = rawText;
      }
    }

    const truncated = cleaned.length > maxChars;
    const content = truncated ? cleaned.slice(0, maxChars) : cleaned;

    return {
      ok: true,
      data: {
        url,
        contentType,
        truncated,
        content
      }
    };
  }
}

function clampInt(value: number, min: number, max: number): number {
  const integer = Math.floor(value);
  return Math.max(min, Math.min(max, integer));
}

function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  const withLineBreaks = withoutScripts
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|pre|blockquote)>/gi, "\n");

  const withoutTags = withLineBreaks.replace(/<[^>]+>/g, " ");
  const decoded = decodeHtmlEntities(withoutTags);
  return decoded
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(text: string): string {
  const namedEntities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": "\"",
    "&#39;": "'",
    "&nbsp;": " "
  };

  let output = text.replace(/&(amp|lt|gt|quot|nbsp);|&#39;/g, (match) => namedEntities[match] ?? match);
  output = output.replace(/&#(\d+);/g, (_, num: string) => String.fromCharCode(Number(num)));
  output = output.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return output;
}
