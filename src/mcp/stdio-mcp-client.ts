import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonObject, McpSettings, McpToolCallResult } from "../core/types";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  method?: string;
  params?: unknown;
}

interface ToolsListResult {
  tools?: unknown;
  nextCursor?: unknown;
}

export interface McpListedTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export class StdioMcpClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private started = false;
  private nextId = 1;
  private readBuffer = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly settings: McpSettings) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (!this.settings.command.trim()) {
      throw new Error("MCP command is empty. Configure mcp.command in agent.config.json.");
    }

    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(this.settings.command);
    this.process = spawn(this.settings.command, this.settings.args, {
      stdio: "pipe",
      shell: useShell,
      env: {
        ...process.env,
        ...this.settings.env
      }
    });

    this.process.stdout.on("data", (chunk: Buffer) => this.onStdoutData(chunk));
    this.process.stderr.on("data", () => {
      // Keep stderr for debugging visibility in the host process.
    });
    this.process.on("error", (error) => {
      this.rejectAllPending(error instanceof Error ? error : new Error(String(error)));
      this.started = false;
      this.process = null;
    });
    this.process.on("exit", () => {
      const error = new Error("MCP process exited.");
      this.rejectAllPending(error);
      this.started = false;
      this.process = null;
    });

    await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "mycoderagent",
          version: "0.2.0"
        }
      },
      this.settings.startupTimeoutMs
    );

    this.notify("notifications/initialized", {});
    this.started = true;
  }

  async callTool(toolName: string, args: JsonObject): Promise<McpToolCallResult> {
    if (!this.started) {
      await this.start();
    }

    const result = await this.request(
      "tools/call",
      {
        name: toolName,
        arguments: args
      },
      this.settings.requestTimeoutMs
    );

    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("MCP tools/call response is invalid.");
    }
    return result as McpToolCallResult;
  }

  async listTools(): Promise<McpListedTool[]> {
    if (!this.started) {
      await this.start();
    }

    const output: McpListedTool[] = [];
    let cursor: string | undefined;
    while (true) {
      const result = (await this.request(
        "tools/list",
        cursor ? { cursor } : {},
        this.settings.requestTimeoutMs
      )) as ToolsListResult;

      if (!result || typeof result !== "object" || Array.isArray(result)) {
        break;
      }
      const tools = normalizeTools((result as ToolsListResult).tools);
      output.push(...tools);

      const nextCursorRaw = (result as ToolsListResult).nextCursor;
      const nextCursor = typeof nextCursorRaw === "string" ? nextCursorRaw.trim() : "";
      if (!nextCursor) {
        break;
      }
      cursor = nextCursor;
    }
    return output;
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }
    this.process.kill("SIGTERM");
    this.process = null;
    this.started = false;
  }

  private onStdoutData(chunk: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);

    while (true) {
      const headerEnd = this.readBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }

      const headerText = this.readBuffer.slice(0, headerEnd).toString("utf8");
      const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!contentLengthMatch) {
        this.readBuffer = this.readBuffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number(contentLengthMatch[1]);
      const frameLength = headerEnd + 4 + contentLength;
      if (this.readBuffer.length < frameLength) {
        return;
      }

      const bodyText = this.readBuffer.slice(headerEnd + 4, frameLength).toString("utf8");
      this.readBuffer = this.readBuffer.slice(frameLength);

      let payload: JsonRpcResponse;
      try {
        payload = JSON.parse(bodyText) as JsonRpcResponse;
      } catch {
        continue;
      }
      this.handleRpcPayload(payload);
    }
  }

  private handleRpcPayload(payload: JsonRpcResponse): void {
    if (typeof payload.id !== "number") {
      return;
    }
    const pending = this.pending.get(payload.id);
    if (!pending) {
      return;
    }
    this.pending.delete(payload.id);

    if (payload.error) {
      pending.reject(new Error(`MCP error ${payload.error.code}: ${payload.error.message}`));
      return;
    }
    pending.resolve(payload.result);
  }

  private async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.process) {
      throw new Error("MCP process is not running.");
    }

    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0" as const,
      id,
      method,
      params
    };
    this.writeFrame(payload);

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  private notify(method: string, params: unknown): void {
    const payload = {
      jsonrpc: "2.0" as const,
      method,
      params
    };
    this.writeFrame(payload);
  }

  private writeFrame(message: unknown): void {
    if (!this.process) {
      throw new Error("MCP process is not running.");
    }
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    this.process.stdin.write(Buffer.concat([header, body]));
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

function normalizeTools(input: unknown): McpListedTool[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const tools: McpListedTool[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) {
      continue;
    }
    const description = typeof record.description === "string" ? record.description : "";
    const inputSchema = toJsonObject(record.inputSchema);
    tools.push({
      name,
      description,
      inputSchema
    });
  }
  return tools;
}

function toJsonObject(input: unknown): JsonObject {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      type: "object",
      properties: {},
      additionalProperties: true
    };
  }
  return input as JsonObject;
}
