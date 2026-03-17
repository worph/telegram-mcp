import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express, { Request, Response, Router } from "express";
import { TelegramBot } from "./bot";
import { SendMessageParams, SendPhotoParams } from "./types";
import { getMcpInfo } from "./mcp-info";

export class MCPServer {
  private bot: TelegramBot;
  private transports: Map<string, SSEServerTransport> = new Map();

  constructor(bot: TelegramBot) {
    this.bot = bot;
  }

  private resolveChatId(providedChatId?: string): string {
    if (providedChatId) return providedChatId;
    const defaultChatId = this.bot.getDefaultChatId();
    if (defaultChatId) return defaultChatId;
    const lastChatId = this.bot.getLastChatId();
    if (lastChatId) return lastChatId;
    throw new Error("Missing chatId: provide it in the tool call or set a default in telegram config");
  }

  private createServer(): Server {
    const server = new Server(
      {
        name: "telegram-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers(server);
    return server;
  }

  private setupHandlers(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "send_message",
            description: "Send a text message to a Telegram chat. If chatId is omitted, the message is sent to the configured default or the last active chat.",
            inputSchema: {
              type: "object" as const,
              properties: {
                chatId: {
                  type: "string",
                  description: "The chat ID to send the message to (optional if default chatId is configured)",
                },
                text: {
                  type: "string",
                  description: "The text message to send",
                },
                parseMode: {
                  type: "string",
                  enum: ["Markdown", "HTML"],
                  description: "Optional parse mode for formatting",
                },
              },
              required: ["text"],
            },
          },
          {
            name: "send_photo",
            description: "Send a photo to a Telegram chat. If chatId is omitted, the photo is sent to the configured default or the last active chat.",
            inputSchema: {
              type: "object" as const,
              properties: {
                chatId: {
                  type: "string",
                  description: "The chat ID to send the photo to (optional if default chatId is configured)",
                },
                url: {
                  type: "string",
                  description: "URL of the photo to send",
                },
                caption: {
                  type: "string",
                  description: "Optional caption for the photo",
                },
              },
              required: ["url"],
            },
          },
          {
            name: "echo",
            description: "Echo a message back — useful for testing the MCP connection",
            inputSchema: {
              type: "object" as const,
              properties: {
                message: {
                  type: "string",
                  description: "The message to echo back",
                },
              },
              required: ["message"],
            },
          },
          {
            name: "mcp_info",
            description: "Send MCP server installation and connection information to a Telegram chat. If chatId is omitted, sends to the configured default or the last active chat.",
            inputSchema: {
              type: "object" as const,
              properties: {
                chatId: {
                  type: "string",
                  description: "The chat ID to send the info to (optional if default chatId is configured)",
                },
              },
              required: [],
            },
          },
        ],
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "send_message": {
            const params = args as unknown as SendMessageParams;
            if (!params.text) {
              throw new Error("Missing required parameter: text");
            }
            const chatId = this.resolveChatId(params.chatId);
            await this.bot.sendMessage(chatId, params.text, params.parseMode);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Message sent to chat ${chatId}`,
                },
              ],
            };
          }

          case "send_photo": {
            const params = args as unknown as SendPhotoParams;
            if (!params.url) {
              throw new Error("Missing required parameter: url");
            }
            const chatId = this.resolveChatId(params.chatId);
            await this.bot.sendPhoto(chatId, params.url, params.caption);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Photo sent to chat ${chatId}`,
                },
              ],
            };
          }

          case "echo": {
            const { message } = args as { message: string };
            if (!message) throw new Error("Missing required parameter: message");
            return {
              content: [{ type: "text" as const, text: message }],
            };
          }

          case "mcp_info": {
            const params = args as unknown as { chatId?: string };
            const chatId = this.resolveChatId(params.chatId);
            const info = getMcpInfo();
            await this.bot.sendMessage(chatId, info, "Markdown");
            return {
              content: [
                {
                  type: "text" as const,
                  text: `MCP info sent to chat ${chatId}`,
                },
              ],
            };
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  createRouter(): Router {
    const router = Router();

    // Stateless HTTP POST endpoint for direct JSON-RPC calls (e.g. from claude-code-container)
    router.post("/", express.json(), async (req: Request, res: Response) => {
      console.log("MCP HTTP POST request received");

      const server = this.createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
      });

      // Clean up server when transport closes
      res.on("close", () => {
        server.close().catch(console.error);
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    // SSE endpoint for MCP
    router.get("/sse", async (req: Request, res: Response) => {
      console.log("MCP SSE connection established");

      const transport = new SSEServerTransport("/mcp/messages", res);
      const sessionId = transport.sessionId;
      this.transports.set(sessionId, transport);

      console.log(`MCP session created: ${sessionId}`);

      const server = this.createServer();

      res.on("close", () => {
        console.log(`MCP SSE connection closed: ${sessionId}`);
        this.transports.delete(sessionId);
        server.close().catch(console.error);
      });

      await server.connect(transport);
    });

    // Messages endpoint for MCP
    router.post("/messages", async (req: Request, res: Response) => {
      const sessionId = req.query.sessionId as string;
      console.log(`MCP message received for session: ${sessionId}`);

      const transport = this.transports.get(sessionId);

      if (!transport) {
        console.error(`Session not found: ${sessionId}, active sessions: ${Array.from(this.transports.keys()).join(", ")}`);
        res.status(404).json({ error: "Session not found" });
        return;
      }

      await transport.handlePostMessage(req, res);
    });

    return router;
  }

  async stop(): Promise<void> {
    for (const transport of this.transports.values()) {
      // Close all active transports
    }
    this.transports.clear();
    console.log("MCP Server stopped");
  }
}
