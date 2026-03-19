import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { resolveTemplate } from "./template.js";
import { TargetConfig } from "./types.js";

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

  /**
   * Send a text message through the configured tool, resolving the params
   * template with {{text}} substituted — same path as a real Telegram message.
   */
  async sendText(text: string, permissionCallbackUrl?: string): Promise<unknown> {
    // Generate a random chatId prefixed with "web-" so the permission router
    // knows to route it to the Web UI instead of Telegram.
    const webChatId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const params = resolveTemplate(this.config.params, {
      text,
      chatId: webChatId,
      userId: "",
      username: undefined,
      firstName: "",
      lastName: undefined,
      messageId: 0,
      date: Math.floor(Date.now() / 1000),
      isBot: false,
      languageCode: undefined,
      permissionCallbackUrl,
    }) as Record<string, unknown>;
    return this.callTool(this.config.tool, params);
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
