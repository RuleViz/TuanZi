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

    async callTool(toolName: string, args: JsonObject): Promise<McpToolCallResult> {
        const result = await this.request("tools/call", {
            name: toolName,
            arguments: args
        });
        return result as McpToolCallResult;
    }

    private async request(method: string, params: unknown): Promise<unknown> {
        const id = Math.floor(Math.random() * 1000000);
        const body = JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params
        });

        try {
            const response = await fetch(this.settings.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...this.settings.headers
                },
                body,
                signal: this.settings.requestTimeoutMs ? AbortSignal.timeout(this.settings.requestTimeoutMs) : undefined
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
            throw new Error(`Remote MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
