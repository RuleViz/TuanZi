import type { JsonObject, McpToolCallResult } from "../core/types";
import type { McpListedTool } from "./stdio-mcp-client";

export interface RemoteMcpSettings {
    url: string;
    headers?: Record<string, string>;
    requestTimeoutMs?: number;
}

export class RemoteMcpClient {
  private started = false;

  constructor(private readonly settings: RemoteMcpSettings) { }

  async start(): Promise<void> {
    if (this.started) return;
    // For now, we just verify the URL is reachable or just assume it's ready.
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async listTools(): Promise<McpListedTool[]> {
    // Basic implementation using fetch for JSON-RPC
    const result = await this.request("tools/list", {});
    if (result && typeof result === "object" && "tools" in result) {
      return (result as any).tools as McpListedTool[];
    }
    return [];
  }

  async callTool(toolName: string, args: JsonObject, options?: { signal?: AbortSignal }): Promise<McpToolCallResult> {
    const result = await this.request(
      "tools/call",
      {
        name: toolName,
        arguments: args
      },
      options
    );
    return result as McpToolCallResult;
  }

  private async request(method: string, params: unknown, options?: { signal?: AbortSignal }): Promise<unknown> {
    const id = Math.floor(Math.random() * 1000000);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    });

    const controller = new AbortController();
    let timedOut = false;
    let abortedByUser = false;
    let timeout: NodeJS.Timeout | null = null;

    const onAbort = (): void => {
      abortedByUser = true;
      controller.abort();
    };

    if (options?.signal) {
      if (options.signal.aborted) {
        abortedByUser = true;
        controller.abort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    if (this.settings.requestTimeoutMs && this.settings.requestTimeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.settings.requestTimeoutMs);
    }

    try {
      const response = await fetch(this.settings.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.settings.headers
        },
        body,
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const payload = (await response.json()) as any;
      if (payload.error) {
        throw new Error(`MCP error ${payload.error.code}: ${payload.error.message}`);
      }
      return payload.result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (abortedByUser) {
          throw new Error(`Remote MCP request aborted by user: ${method}`);
        }
        if (timedOut) {
          throw new Error(`Remote MCP request timed out: ${method} (${this.settings.requestTimeoutMs}ms)`);
        }
      }
      throw new Error(`Remote MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (options?.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
    }
  }
}
