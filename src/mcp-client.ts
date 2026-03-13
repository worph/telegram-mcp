import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { TargetConfig } from "./types";

export class MCPClient {
  private config: TargetConfig;
  private client: Client | null = null;
  private transport: SSEClientTransport | null = null;
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
      this.transport = new SSEClientTransport(url);

      await this.client.connect(this.transport);
      this.connected = true;
      console.log(`MCP Client connected to ${this.config.url}`);
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
