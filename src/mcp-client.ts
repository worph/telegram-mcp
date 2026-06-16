import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { Config, TargetConfig } from "./types.js";

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

      const rawTransport: Transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers,
        },
      });

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

  getTargetInfo(): { url: string; tool: string; transport: string } {
    return {
      url: this.config.url,
      tool: this.config.tool,
      transport: this.config.transport,
    };
  }

  updateConfig(config: TargetConfig): void {
    this.config = config;
    if (this.connected) {
      this.disconnect().catch(console.error);
    }
  }
}

/**
 * Routes each chat to its target MCP server. The top-level `target` is the
 * catch-all default; `chatTargets` entries override it for specific chat IDs.
 * Holds one MCPClient per distinct target (the default plus each chatTargets
 * entry) so different chats can talk to different MCP servers, or the same
 * server with a different tool/params/auth, concurrently.
 */
export class MCPClientPool {
  private defaultTarget!: TargetConfig;
  private defaultClient!: MCPClient;
  private chatEntries!: Array<{ chatIds: Set<string>; target: TargetConfig; client: MCPClient }>;

  constructor(config: Config) {
    this.build(config);
  }

  private build(config: Config): void {
    this.defaultTarget = config.target;
    this.defaultClient = new MCPClient(config.target);
    this.chatEntries = (config.chatTargets ?? []).map((t) => ({
      chatIds: new Set(t.chatIds.map(String)),
      target: t,
      client: new MCPClient(t),
    }));
  }

  /**
   * Resolve the client + target config for a chat. Returns the first
   * chatTargets entry that lists this chat, else the catch-all default.
   */
  resolve(chatId: string | number): { client: MCPClient; target: TargetConfig } {
    const id = String(chatId);
    for (const entry of this.chatEntries) {
      if (entry.chatIds.has(id)) {
        return { client: entry.client, target: entry.target };
      }
    }
    return { client: this.defaultClient, target: this.defaultTarget };
  }

  private allClients(): MCPClient[] {
    return [this.defaultClient, ...this.chatEntries.map((e) => e.client)];
  }

  async connectAll(): Promise<void> {
    await Promise.allSettled(this.allClients().map((c) => c.connect()));
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled(this.allClients().map((c) => c.disconnect()));
  }

  /** Tear down existing clients and rebuild from the new config (not connected). */
  updateConfig(config: Config): void {
    this.disconnectAll().catch(console.error);
    this.build(config);
  }

  /** The default (catch-all) client — used for overall status reporting. */
  getDefaultClient(): MCPClient {
    return this.defaultClient;
  }

  isConnected(): boolean {
    return this.allClients().some((c) => c.isConnected());
  }
}
