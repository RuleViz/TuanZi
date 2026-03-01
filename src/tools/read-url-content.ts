import type { JsonObject, Tool, ToolExecutionContext, ToolExecutionResult } from "../core/types";
import { FetchUrlTool } from "./fetch-url";

export class ReadUrlContentTool implements Tool {
  readonly definition = {
    name: "read_url_content",
    description: "Alias of fetch_url. Fetch URL content and return cleaned text.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "http/https URL to fetch." },
        max_chars: { type: "number", description: "Maximum returned characters." }
      },
      required: ["url"],
      additionalProperties: false
    }
  };

  private readonly delegate = new FetchUrlTool();

  async execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    return this.delegate.execute(input, context);
  }
}
