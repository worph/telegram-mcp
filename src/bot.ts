import { Bot, Context } from "grammy";
import { BotStatus, Config, MessageContext } from "./types";
import { createMessageContext, resolveTemplate } from "./template";
import { MCPClient } from "./mcp-client";

export class TelegramBot {
  private bot: Bot | null = null;
  private config: Config;
  private mcpClient: MCPClient | null = null;
  private status: BotStatus = { running: false };
  private isShuttingDown = false;

  constructor(config: Config) {
    this.config = config;
  }

  setMCPClient(client: MCPClient): void {
    this.mcpClient = client;
  }

  async start(): Promise<void> {
    if (this.bot) {
      await this.stop();
    }

    this.isShuttingDown = false;
    this.bot = new Bot(this.config.telegram.botToken);

    // Handle /mcp command - show MCP info
    this.bot.command("mcp", async (ctx) => {
      if (!this.mcpClient) {
        await ctx.reply("MCP client not connected");
        return;
      }
      try {
        await this.mcpClient.callTool("mcp_info", {
          chatId: String(ctx.chat.id),
        });
      } catch (err) {
        console.error("Error calling mcp_info:", err);
        await ctx.reply("Failed to get MCP info");
      }
    });

    // Handle /start command - welcome message
    this.bot.command("start", async (ctx) => {
      const username = ctx.from?.first_name || "there";
      await ctx.reply(
        `Hello ${username}! 👋\n\n` +
        `I'm a Telegram MCP bridge bot. Send me any message and I'll forward it to the configured MCP tool.\n\n` +
        `Commands:\n` +
        `/mcp - Show MCP server connection info\n` +
        `/start - Show this help message`
      );
    });

    this.bot.on("message:text", async (ctx) => {
      // Skip if it's a command
      if (ctx.message?.text?.startsWith("/")) {
        return;
      }
      await this.handleTextMessage(ctx);
    });

    this.bot.catch((err) => {
      console.error("Bot error:", err);
      this.status.error = String(err);
    });

    try {
      const me = await this.bot.api.getMe();
      this.status.botUsername = me.username;
      this.status.running = true;
      this.status.error = undefined;

      console.log(`Bot started as @${me.username}`);

      this.bot.start({
        onStart: () => {
          console.log("Bot polling started");
        },
      });
    } catch (err) {
      this.status.running = false;
      this.status.error = String(err);
      console.error("Failed to start bot:", err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.bot && !this.isShuttingDown) {
      this.isShuttingDown = true;
      console.log("Stopping bot...");
      await this.bot.stop();
      this.bot = null;
      this.status.running = false;
      console.log("Bot stopped");
    }
  }

  getStatus(): BotStatus {
    return { ...this.status };
  }

  getBot(): Bot | null {
    return this.bot;
  }

  updateConfig(config: Config): void {
    this.config = config;
  }

  private async handleTextMessage(ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!message || !message.text || !message.from) {
      return;
    }

    this.status.lastMessageAt = Date.now();

    const messageContext: MessageContext = createMessageContext(
      message.text,
      message.chat.id,
      message.from.id,
      message.from.username,
      message.from.first_name,
      message.from.last_name,
      message.message_id,
      message.date,
      message.from.is_bot,
      message.from.language_code
    );

    console.log(`Received message from ${messageContext.username || messageContext.userId}: ${messageContext.text}`);

    if (!this.mcpClient) {
      console.warn("MCP client not set, skipping tool call");
      return;
    }

    try {
      const resolvedParams = resolveTemplate(
        this.config.target.params,
        messageContext
      );

      console.log(`Calling MCP tool: ${this.config.target.tool}`);
      const result = await this.mcpClient.callTool(
        this.config.target.tool,
        resolvedParams as Record<string, unknown>
      );
      console.log("MCP tool result:", result);
    } catch (err) {
      console.error("Error calling MCP tool:", err);
    }
  }

  async sendMessage(chatId: string, text: string, parseMode?: "Markdown" | "HTML"): Promise<void> {
    if (!this.bot) {
      throw new Error("Bot not running");
    }

    const options = parseMode ? { parse_mode: parseMode } : undefined;
    await this.bot.api.sendMessage(chatId, text, options);
  }

  async sendPhoto(chatId: string, url: string, caption?: string): Promise<void> {
    if (!this.bot) {
      throw new Error("Bot not running");
    }

    await this.bot.api.sendPhoto(chatId, url, caption ? { caption } : undefined);
  }
}
