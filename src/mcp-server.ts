import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express, { Request, Response, Router } from "express";
import { TelegramBot } from "./bot.js";
import { AskParams, EditMessageParams, GetAnswerParams, SendMessageParams, SendPhotoParams } from "./types.js";
import { getMcpInfo } from "./mcp-info.js";
import { getHistory } from "./history.js";
import {
  AskQuestionRecord,
  MAX_QUESTION_TIMEOUT_SECONDS,
  MAX_WAIT_SECONDS,
  cancelQuestion,
  createQuestion,
  getLatestQuestion,
  getQuestion,
  setQuestionMessageId,
  waitForAnswer,
} from "./ask-service.js";

export class MCPServer {
  private bot: TelegramBot;

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

  private askResultText(record: AskQuestionRecord): string {
    const out: Record<string, unknown> = {
      questionId: record.questionId,
      status: record.status,
      chatId: record.chatId,
      question: record.question,
    };
    if (record.status === "answered") {
      out.answer = record.answer;
      if (record.answeredBy) out.answeredBy = record.answeredBy;
    } else if (record.status === "pending") {
      out.expiresInSeconds = Math.max(Math.round((record.expiresAt - Date.now()) / 1000), 0);
      out.hint = `Answer not received yet. Call get_answer with this questionId (waitSeconds up to ${MAX_WAIT_SECONDS} to long-poll) until status is "answered".`;
    } else {
      out.hint = "Question expired without an answer. Ask again if the information is still needed.";
    }
    return JSON.stringify(out, null, 2);
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
                buttons: {
                  type: "array",
                  description:
                    "Optional inline keyboard: an array of button rows (each row is an array of buttons). A button either taps back to the bot — set callbackData, which is forwarded to the target MCP as {{callbackData}} — or opens a link (set url). callbackData must be <=64 bytes; carry larger context in the message text and read it back via {{callbackMessageText}}.",
                  items: {
                    type: "array",
                    items: {
                      type: "object" as const,
                      properties: {
                        text: { type: "string", description: "Button label" },
                        callbackData: {
                          type: "string",
                          description: "Opaque payload sent back on tap (<=64 bytes), forwarded to the target MCP",
                        },
                        url: { type: "string", description: "Open this URL instead of sending a callback" },
                        lockOnTap: {
                          type: "boolean",
                          description: "One-shot button (callbackData only): the first tap immediately locks the message — the keyboard collapses to just the chosen option and further taps are ignored — before the tap is forwarded. Use for Approve/Decline prompts so the user clicks once; leave unset for menus the user taps repeatedly.",
                        },
                      },
                      required: ["text"],
                    },
                  },
                },
                disablePreview: {
                  type: "boolean",
                  description: "Suppress Telegram's auto link-preview card. Recommended for short notification messages that contain links.",
                },
              },
              required: ["text"],
            },
          },
          {
            name: "edit_message",
            description:
              "Edit a message previously sent by the bot — change its text and/or its inline buttons. Use this to 'lock' an approval message after a decision (e.g. set text to '✅ Approved' and omit buttons to remove them). Provide messageId from the original send. If buttons is omitted, the keyboard is removed.",
            inputSchema: {
              type: "object" as const,
              properties: {
                chatId: {
                  type: "string",
                  description: "The chat ID containing the message (optional if default chatId is configured)",
                },
                messageId: {
                  type: "number",
                  description: "The message_id of the message to edit (returned when it was sent)",
                },
                text: {
                  type: "string",
                  description: "New text. Omit to only update the buttons.",
                },
                parseMode: {
                  type: "string",
                  enum: ["Markdown", "HTML"],
                  description: "Optional parse mode for formatting the new text",
                },
                buttons: {
                  type: "array",
                  description: "New inline keyboard (same shape as send_message.buttons). Omit to remove all buttons.",
                  items: {
                    type: "array",
                    items: {
                      type: "object" as const,
                      properties: {
                        text: { type: "string", description: "Button label" },
                        callbackData: { type: "string", description: "Opaque payload sent back on tap (<=64 bytes)" },
                        url: { type: "string", description: "Open this URL instead of sending a callback" },
                        lockOnTap: {
                          type: "boolean",
                          description: "One-shot button: first tap locks the message to the chosen option before forwarding. See send_message for details.",
                        },
                      },
                      required: ["text"],
                    },
                  },
                },
                disablePreview: {
                  type: "boolean",
                  description: "Suppress Telegram's auto link-preview card on the edited message.",
                },
              },
              required: ["messageId"],
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
            name: "ask",
            description:
              "Ask the user a question via Telegram and collect their reply (human-in-the-loop). Sends the question and returns immediately with a questionId — the user's next reply in that chat is captured as the answer instead of being forwarded to the target MCP. Poll get_answer with the questionId until it is answered. Optionally set waitSeconds (max 240) to wait for a quick answer within this same call. If chatId is omitted, uses the configured default or the last active chat.",
            inputSchema: {
              type: "object" as const,
              properties: {
                question: {
                  type: "string",
                  description: "The question to ask the user",
                },
                chatId: {
                  type: "string",
                  description: "The chat ID to ask in (optional if default chatId is configured)",
                },
                timeoutSeconds: {
                  type: "number",
                  description: `How long the question stays open before expiring, in seconds (default and max ${MAX_QUESTION_TIMEOUT_SECONDS} = 24h)`,
                },
                waitSeconds: {
                  type: "number",
                  description: `Seconds to wait for an answer before this call returns (0-${MAX_WAIT_SECONDS}, default 0 = return immediately)`,
                },
              },
              required: ["question"],
            },
          },
          {
            name: "get_answer",
            description:
              `Get the user's answer to a question previously created with ask. Set waitSeconds (max ${MAX_WAIT_SECONDS}) to long-poll: the call returns as soon as the answer arrives, or after waitSeconds if still pending. Keep calling until status is "answered" or "expired"; for waits of hours, check back periodically instead of holding one connection open. If questionId is omitted, the most recent question is used.`,
            inputSchema: {
              type: "object" as const,
              properties: {
                questionId: {
                  type: "string",
                  description: "The questionId returned by ask (optional — defaults to the most recent question)",
                },
                chatId: {
                  type: "string",
                  description: "When questionId is omitted, scope 'most recent question' to this chat",
                },
                waitSeconds: {
                  type: "number",
                  description: `Seconds to long-poll for the answer (0-${MAX_WAIT_SECONDS}, default 0 = return current status immediately)`,
                },
              },
              required: [],
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
          {
            name: "get_chat_history",
            description: "Retrieve recent messages from a Telegram conversation for added context. Returns the rolling transcript the bot has seen (user messages and bot replies), most recent last. Note: only messages received since the bot started storing are available — there is no backfill of older history. If chatId is omitted, uses the configured default or the last active chat.",
            inputSchema: {
              type: "object" as const,
              properties: {
                chatId: {
                  type: "string",
                  description: "The chat ID to fetch history for (optional if default chatId is configured)",
                },
                limit: {
                  type: "number",
                  description: "Maximum number of recent messages to return (default 20)",
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
            const messageId = await this.bot.sendMessage(chatId, params.text, params.parseMode, params.buttons, params.disablePreview);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Message sent to chat ${chatId} (messageId ${messageId})`,
                },
              ],
            };
          }

          case "edit_message": {
            const params = args as unknown as EditMessageParams;
            if (params.messageId === undefined || params.messageId === null) {
              throw new Error("Missing required parameter: messageId");
            }
            if (params.text === undefined && params.buttons === undefined) {
              throw new Error("Provide at least one of: text, buttons");
            }
            const chatId = this.resolveChatId(params.chatId);
            await this.bot.editMessage(chatId, params.messageId, {
              text: params.text,
              parseMode: params.parseMode,
              buttons: params.buttons,
              disablePreview: params.disablePreview,
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Message ${params.messageId} in chat ${chatId} edited`,
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

          case "ask": {
            const params = args as unknown as AskParams;
            if (!params.question) {
              throw new Error("Missing required parameter: question");
            }
            const chatId = this.resolveChatId(params.chatId);
            const record = createQuestion(chatId, params.question, params.timeoutSeconds);
            let messageId: number;
            try {
              messageId = await this.bot.sendQuestion(chatId, params.question);
            } catch (err) {
              cancelQuestion(record.questionId);
              throw err;
            }
            setQuestionMessageId(record.questionId, messageId);
            const result =
              params.waitSeconds && params.waitSeconds > 0
                ? await waitForAnswer(record.questionId, params.waitSeconds)
                : getQuestion(record.questionId);
            return {
              content: [
                {
                  type: "text" as const,
                  text: this.askResultText(result ?? record),
                },
              ],
            };
          }

          case "get_answer": {
            const params = args as unknown as GetAnswerParams;
            let questionId = params.questionId;
            if (!questionId) {
              const latest = getLatestQuestion(params.chatId);
              if (!latest) {
                throw new Error(
                  params.chatId ? `No questions found for chat ${params.chatId}` : "No questions found"
                );
              }
              questionId = latest.questionId;
            }
            const record = await waitForAnswer(questionId, params.waitSeconds ?? 0);
            if (!record) {
              throw new Error(
                `Unknown questionId: ${questionId} (questions are purged about an hour after they expire)`
              );
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: this.askResultText(record),
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

          case "get_chat_history": {
            const params = args as unknown as { chatId?: string; limit?: number };
            const chatId = this.resolveChatId(params.chatId);
            const messages = getHistory(chatId, params.limit ?? 20);
            if (messages.length === 0) {
              return {
                content: [
                  { type: "text" as const, text: `No stored history for chat ${chatId}.` },
                ],
              };
            }
            const transcript = messages
              .map((m) => {
                const ts = new Date(m.date * 1000).toISOString().replace("T", " ").slice(0, 16);
                const who = m.role === "assistant" ? "assistant" : m.name || "user";
                return `[${ts}] ${who}: ${m.text}`;
              })
              .join("\n");
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Recent conversation for chat ${chatId} (${messages.length} message(s)):\n\n${transcript}`,
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

    return router;
  }

  async stop(): Promise<void> {
    console.log("MCP Server stopped");
  }
}
