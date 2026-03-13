import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Request, Response, Router } from "express";
import * as os from "os";
import { TelegramBot } from "./bot";
import { SendMessageParams, SendPhotoParams } from "./types";

function getMcpInfo(): string {
  const baseUrl = process.env.BASE_URL || "http://localhost:8080";
  const hostname = os.hostname();
  const port = process.env.PORT || "8080";

  const info = `
🔌 *MCP Server Installation Info*

*Server Name:* telegram-mcp
*Version:* 1.0.0

━━━━━━━━━━━━━━━━━━━━━━

📡 *Connection Endpoints*

*HTTP/SSE (recommended):*
\`${baseUrl}/mcp/sse\`

*Docker Network:*
\`http://${hostname}:${port}/mcp/sse\`

━━━━━━━━━━━━━━━━━━━━━━

⚙️ *Supported Transports*
• SSE (Server-Sent Events) ✅
• HTTP ✅

━━━━━━━━━━━━━━━━━━━━━━

🛠️ *Available Tools*

1. \`send_message\` - Send text message
   • chatId (required): Target chat ID
   • text (required): Message content
   • parseMode: "Markdown" or "HTML"

2. \`send_photo\` - Send photo
   • chatId (required): Target chat ID
   • url (required): Photo URL
   • caption: Optional caption

3. \`echo\` - Echo message back (testing)
   • chatId (required): Target chat ID
   • message (required): Text to echo
   • username: Optional username

4. \`mcp_info\` - Show this info

━━━━━━━━━━━━━━━━━━━━━━

📋 *Example MCP Client Config*

\`\`\`json
{
  "mcpServers": {
    "telegram": {
      "transport": "sse",
      "url": "${baseUrl}/mcp/sse"
    }
  }
}
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━

🐳 *Docker Compose*

\`\`\`yaml
services:
  telegram-mcp:
    image: telegram-mcp
    ports:
      - "8080:8080"
    environment:
      - BASE_URL=http://your-domain.com:8080
\`\`\`
`.trim();

  return info;
}

export class MCPServer {
  private bot: TelegramBot;
  private transports: Map<string, SSEServerTransport> = new Map();

  constructor(bot: TelegramBot) {
    this.bot = bot;
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
            description: "Send a text message to a Telegram chat",
            inputSchema: {
              type: "object" as const,
              properties: {
                chatId: {
                  type: "string",
                  description: "The chat ID to send the message to",
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
              required: ["chatId", "text"],
            },
          },
          {
            name: "send_photo",
            description: "Send a photo to a Telegram chat",
            inputSchema: {
              type: "object" as const,
              properties: {
                chatId: {
                  type: "string",
                  description: "The chat ID to send the photo to",
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
              required: ["chatId", "url"],
            },
          },
          {
            name: "echo",
            description: "Echo a message back to the Telegram chat (useful for testing)",
            inputSchema: {
              type: "object" as const,
              properties: {
                chatId: {
                  type: "string",
                  description: "The chat ID to echo the message to",
                },
                message: {
                  type: "string",
                  description: "The message to echo back",
                },
                username: {
                  type: "string",
                  description: "Optional username of the sender",
                },
              },
              required: ["chatId", "message"],
            },
          },
          {
            name: "mcp_info",
            description: "Send MCP server installation and connection information to a Telegram chat",
            inputSchema: {
              type: "object" as const,
              properties: {
                chatId: {
                  type: "string",
                  description: "The chat ID to send the info to",
                },
              },
              required: ["chatId"],
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
            if (!params.chatId || !params.text) {
              throw new Error("Missing required parameters: chatId and text");
            }
            await this.bot.sendMessage(params.chatId, params.text, params.parseMode);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Message sent to chat ${params.chatId}`,
                },
              ],
            };
          }

          case "send_photo": {
            const params = args as unknown as SendPhotoParams;
            if (!params.chatId || !params.url) {
              throw new Error("Missing required parameters: chatId and url");
            }
            await this.bot.sendPhoto(params.chatId, params.url, params.caption);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Photo sent to chat ${params.chatId}`,
                },
              ],
            };
          }

          case "echo": {
            const params = args as unknown as { chatId: string; message: string; username?: string };
            if (!params.chatId || !params.message) {
              throw new Error("Missing required parameters: chatId and message");
            }
            const prefix = params.username ? `@${params.username}: ` : "";
            const echoText = `🔄 Echo: ${prefix}${params.message}`;
            await this.bot.sendMessage(params.chatId, echoText);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Echoed message to chat ${params.chatId}`,
                },
              ],
            };
          }

          case "mcp_info": {
            const params = args as unknown as { chatId: string };
            if (!params.chatId) {
              throw new Error("Missing required parameter: chatId");
            }
            const info = getMcpInfo();
            await this.bot.sendMessage(params.chatId, info, "Markdown");
            return {
              content: [
                {
                  type: "text" as const,
                  text: `MCP info sent to chat ${params.chatId}`,
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
