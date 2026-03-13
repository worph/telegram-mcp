import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { TargetConfig } from "./types";

/**
 * Wraps a transport to silently ignore errors when sending
 * 'notifications/initialized', which some servers don't support.
 */
function wrapTransport(inner: Transport): Transport {
  const originalSend = inner.send.bind(inner);
  inner.send = async (message: JSONRPCMessage) => {
    if ("method" in message && message.method === "notifications/initialized") {
      try {
        await originalSend(message);
      } catch (err: any) {
        console.warn(
          "MCP server does not support notifications/initialized, continuing anyway"
        );
      }
      return;
    }
    return originalSend(message);
  };
  return inner;
}

export class MCPClient {
  private config: TargetConfig;
  private client: Client | null = null;
  private transport: Transport | null = null;
  private connected = false;

  constructor(config: TargetConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      this.client = new Client(
        {
          name: "telegram-mcp-client",
          version: "1.0.0",
        },
        {
          capabilities: {},
        }
      );

      const url = new URL(this.config.url);
      const headers: Record<string, string> = {};
      if (this.config.authToken) {
        headers["Authorization"] = `Bearer ${this.config.authToken}`;
      }

      let rawTransport: Transport;
      if (this.config.transport === "http") {
        rawTransport = new StreamableHTTPClientTransport(url, {
          requestInit: {
            headers,
          },
        });
      } else {
        rawTransport = new SSEClientTransport(url, {
          requestInit: {
            headers,
          },
        });
      }

      this.transport = wrapTransport(rawTransport);

      await this.client.connect(this.transport);
      this.connected = true;
      console.log(`MCP Client connected to ${this.config.url} (${this.config.transport})`);
    } catch (error) {
      this.connected = false;
      console.error("Failed to connect MCP client:", error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.close();
      this.client = null;
      this.transport = null;
      this.connected = false;
      console.log("MCP Client disconnected");
    }
  }

  async callTool(toolName: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.connected || !this.client) {
      await this.connect();
    }

    if (!this.client) {
      throw new Error("MCP client not connected");
    }

    try {
      const result = await this.client.callTool({
        name: toolName,
        arguments: params,
      }, undefined, {
        timeout: 180_000, // 3 minutes to allow for permission prompts
      });

      return result;
    } catch (error) {
      console.error(`Error calling tool ${toolName}:`, error);
      throw error;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  updateConfig(config: TargetConfig): void {
    this.config = config;
    if (this.connected) {
      this.disconnect().catch(console.error);
    }
  }
}
