import { PingRoomError } from './errors.js';
import type { HttpClient } from './http.js';
import { normalizeRedeemCode } from './internal/guards.js';
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

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: { name: string; version: string; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Thin client for the PingRoom MCP endpoint (`POST /api/agent/mcp`,
 * JSON-RPC 2.0). Tools are scope-filtered server-side, so `listTools()` returns
 * only what the credential can call.
 */
export class McpClient {
  private nextId = 1;
  private initialization: Promise<McpInitializeResult> | null = null;
  private initializeResult: McpInitializeResult | null = null;
  private protocolVersion: string | null = null;

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
      headers: this.headers(),
    });
    if (res && res.error) {
      throw new PingRoomError(`MCP error ${res.error.code}: ${res.error.message}`, {
        code: `mcp_${res.error.code}`,
        body: res.error,
      });
    }
    return res?.result as T;
  }

  /**
   * Perform the MCP initialize handshake once, including the required
   * `notifications/initialized` notification. Safe to call more than once.
   */
  initialize(params?: Record<string, unknown>): Promise<McpInitializeResult> {
    if (this.initializeResult) {
      return Promise.resolve(this.initializeResult);
    }
    if (this.initialization) {
      return this.initialization;
    }

    this.initialization = this.performInitialize(params).finally(() => {
      this.initialization = null;
    });
    return this.initialization;
  }

  /** Alias for initialize(), useful when treating this helper as a connection. */
  connect(params?: Record<string, unknown>): Promise<McpInitializeResult> {
    return this.initialize(params);
  }

  async listTools(): Promise<{ tools: McpTool[] }> {
    await this.initialize();
    return this.call<{ tools: McpTool[] }>('tools/list');
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    await this.initialize();
    return this.call<McpToolResult>('tools/call', { name, arguments: args });
  }

  /** Redeem a gift or promotional code through the authenticated MCP connection. */
  redeemCode(code: string): Promise<McpToolResult> {
    return this.callTool('redeem_code', { code: normalizeRedeemCode(code) });
  }

  private async performInitialize(params?: Record<string, unknown>): Promise<McpInitializeResult> {
    const result = await this.call<McpInitializeResult>(
      'initialize',
      params ?? {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'pingroom-sdk', version: VERSION },
      },
    );
    if (!result || typeof result.protocolVersion !== 'string') {
      throw new PingRoomError('MCP initialize response did not include a protocol version.', {
        code: 'mcp_invalid_initialize',
        body: result,
      });
    }

    this.protocolVersion = result.protocolVersion;
    await this.notify('notifications/initialized');
    this.initializeResult = result;
    return result;
  }

  private async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const envelope = { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
    await this.http.request('POST', this.path, {
      body: envelope,
      headers: this.headers(),
    });
  }

  private headers(): Record<string, string> {
    return {
      Accept: 'application/json, text/event-stream',
      ...(this.protocolVersion ? { 'MCP-Protocol-Version': this.protocolVersion } : {}),
    };
  }
}
