import type {
  JsonObject,
  ModelFunctionToolDefinition,
  Tool,
  ToolExecutionContext,
  ToolExecutionResult
} from "./types";

export class ToolRegistry {
  private readonly tools: Map<string, Tool>;

  constructor(toolList: Tool[]) {
    this.tools = new Map(toolList.map((tool) => [tool.definition.name, tool]));
  }

  getToolNames(): string[] {
    return [...this.tools.keys()].sort();
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getToolDefinitions(names?: string[]): ModelFunctionToolDefinition[] {
    const pickedTools = names ? names.map((name) => this.tools.get(name)).filter(Boolean) : [...this.tools.values()];

    return pickedTools.map((tool) => ({
      type: "function",
      function: {
        name: tool!.definition.name,
        description: tool!.definition.description,
        parameters: tool!.definition.parameters
      }
    }));
  }

  async execute(name: string, args: JsonObject, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `Unknown tool: ${name}` };
    }

    const policyDecision = context.policyEngine?.evaluateTool(name, args);
    if (policyDecision?.decision === "deny") {
      return { ok: false, error: `Policy denied tool ${name}: ${policyDecision.reason}` };
    }

    try {
      return await tool.execute(args, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }
}
