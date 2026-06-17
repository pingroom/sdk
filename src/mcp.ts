import { PingRoomError } from './errors.js';
import type { HttpClient } from './http.js';
import { VERSION } from './version.js';

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Thin client for the PingRoom MCP endpoint (`POST /api/agent/mcp`,
 * JSON-RPC 2.0). Tools are scope-filtered server-side, so `listTools()` returns
 * only what the credential can call.
 */
export class McpClient {
  private nextId = 1;

  constructor(
    private readonly http: HttpClient,
    private readonly path = '/api/agent/mcp',
  ) {}

  /** Raw JSON-RPC call. Resolves the `result`; throws PingRoomError on a JSON-RPC `error`. */
  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const envelope = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
    const res = await this.http.request<{ result?: T; error?: JsonRpcError }>('POST', this.path, {
      body: envelope,
      headers: { Accept: 'application/json, text/event-stream' },
    });
    if (res && res.error) {
      throw new PingRoomError(`MCP error ${res.error.code}: ${res.error.message}`, {
        code: `mcp_${res.error.code}`,
        body: res.error,
      });
    }
    return res?.result as T;
  }

  initialize(params?: Record<string, unknown>): Promise<unknown> {
    return this.call(
      'initialize',
      params ?? {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'pingroom-sdk', version: VERSION },
      },
    );
  }

  listTools(): Promise<{ tools: McpTool[] }> {
    return this.call<{ tools: McpTool[] }>('tools/list');
  }

  callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    return this.call<McpToolResult>('tools/call', { name, arguments: args });
  }
}
