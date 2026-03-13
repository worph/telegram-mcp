import { Bot, Context } from "grammy";
import { BotStatus, Config, MessageContext } from "./types";
import { createMessageContext, resolveTemplate } from "./template";
import { MCPClient } from "./mcp-client";
import { PermissionService } from "./permission-service";

// Characters that must be escaped in MarkdownV2 outside of code blocks
const MD_SPECIAL = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

/**
 * Escape text for Telegram MarkdownV2 while preserving common Markdown formatting.
 * Handles: bold, italic, strikethrough, code/pre blocks, and links.
 * Everything else gets escaped.
 */
function escapeMarkdownV2(text: string): string {
  const parts: string[] = [];
  // Match code blocks, inline code, bold, italic, strikethrough, links — preserve them; escape the rest
  const pattern = /(```[\s\S]*?```|`[^`\n]+`|\*\*[\s\S]*?\*\*|\*[^*\n]+\*|__[\s\S]*?__|_[^_\n]+_|~~[\s\S]*?~~|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    // Escape plain text before this match
    if (match.index > lastIndex) {
      parts.push(escapeRaw(text.slice(lastIndex, match.index)));
    }
    const token = match[0];
    if (token.startsWith("```")) {
      // Pre block: escape nothing inside
      parts.push(token);
    } else if (token.startsWith("`")) {
      // Inline code: escape nothing inside
      parts.push(token);
    } else if (token.startsWith("**")) {
      // Bold: escape inner text
      const inner = token.slice(2, -2);
      parts.push(`*${escapeRaw(inner)}*`);
    } else if (token.startsWith("__")) {
      // Underline (Telegram's __): escape inner text
      const inner = token.slice(2, -2);
      parts.push(`__${escapeRaw(inner)}__`);
    } else if (token.startsWith("*")) {
      // Italic: escape inner text
      const inner = token.slice(1, -1);
      parts.push(`_${escapeRaw(inner)}_`);
    } else if (token.startsWith("_")) {
      // Italic: escape inner text
      const inner = token.slice(1, -1);
      parts.push(`_${escapeRaw(inner)}_`);
    } else if (token.startsWith("~~")) {
      // Strikethrough: escape inner text
      const inner = token.slice(2, -2);
      parts.push(`~${escapeRaw(inner)}~`);
    } else if (token.startsWith("[")) {
      // Link [text](url)
      const linkText = escapeRaw(match[2]);
      const url = match[3];
      parts.push(`[${linkText}](${url})`);
    }
    lastIndex = match.index + token.length;
  }

  // Escape remaining plain text
  if (lastIndex < text.length) {
    parts.push(escapeRaw(text.slice(lastIndex)));
  }

  return parts.join("");
}

function escapeRaw(text: string): string {
  return text.replace(MD_SPECIAL, "\\$1");
}

export class TelegramBot {
  private bot: Bot | null = null;
  private config: Config;
  private mcpClient: MCPClient | null = null;
  private permissionService: PermissionService | null = null;
  private status: BotStatus = { running: false };
  private isShuttingDown = false;
  // Chat IDs that should start a new conversation on their next message
  private newSessionChats: Set<string> = new Set();

  constructor(config: Config) {
    this.config = config;
  }

  setMCPClient(client: MCPClient): void {
    this.mcpClient = client;
  }

  setPermissionService(service: PermissionService): void {
    this.permissionService = service;
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
        `/new - Start a fresh conversation\n` +
        `/mcp - Show MCP connection info\n` +
        `/revoke - Revoke all "Always Allow" tool permissions\n` +
        `/start - Show this help message`
      );
    });

    // Handle /revoke command - clear tool allowlist
    this.bot.command("revoke", async (ctx) => {
      if (!this.permissionService) {
        await ctx.reply("Permission service not configured");
        return;
      }
      const revoked = this.permissionService.revokeAllowedTools();
      if (revoked.length === 0) {
        await ctx.reply("No tools were in the allowlist.");
      } else {
        await ctx.reply(`Revoked always-allow for: ${revoked.map(t => `\`${t}\``).join(", ")}`, { parse_mode: "Markdown" });
      }
    });

    // Handle /new command - start a fresh conversation
    this.bot.command("new", async (ctx) => {
      this.newSessionChats.add(String(ctx.chat.id));
      await ctx.reply("——— New conversation ———\nContext has been reset. Next message starts a fresh session.");
    });

    this.bot.on("message:text", async (ctx) => {
      // Skip if it's a command
      if (ctx.message?.text?.startsWith("/")) {
        return;
      }
      // Fire off message handling without awaiting, so grammY can process
      // other updates (e.g. permission callback queries) concurrently.
      // Otherwise the sequential update processing creates a deadlock:
      // text handler waits for MCP → MCP waits for permission → permission
      // callback is queued behind the still-running text handler.
      this.handleTextMessage(ctx).catch((err) => {
        console.error("Error in handleTextMessage:", err);
      });
    });

    // Handle permission callback queries (inline keyboard button presses)
    this.bot.callbackQuery(/^perm:(allow|deny|always):(.+)$/, async (ctx) => {
      const match = ctx.callbackQuery.data.match(/^perm:(allow|deny|always):(.+)$/);
      if (!match) {
        await ctx.answerCallbackQuery({ text: "Invalid callback data" });
        return;
      }

      const [, decision, queryId] = match;
      console.log(`Permission callback: ${decision} for queryId: ${queryId}`);

      // Acknowledge the callback query (may fail if query is too old, that's ok)
      const ackText = decision === "deny" ? "Denied" : decision === "always" ? "Always allowed" : "Allowed";
      try {
        await ctx.answerCallbackQuery({ text: ackText });
      } catch {
        console.warn("Failed to answer callback query (may be expired), continuing with permission resolution");
      }

      // Resolve the permission
      if (this.permissionService) {
        const resolved = await this.permissionService.resolvePermission(
          queryId,
          decision as "allow" | "deny" | "always"
        );
        if (!resolved) {
          console.warn(`Failed to resolve permission for queryId: ${queryId}`);
        }
      } else {
        console.warn("Permission service not set, ignoring callback");
      }
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

      // Sync command menu with BotFather so it always matches actual handlers
      await this.bot.api.setMyCommands([
        { command: "new", description: "Start a fresh conversation" },
        { command: "mcp", description: "Show MCP connection info" },
        { command: "revoke", description: "Revoke all Always Allow permissions" },
        { command: "start", description: "Show help message" },
      ]);

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
      ) as Record<string, unknown>;

      // If /new was used, start a fresh session and consume the flag
      const chatId = String(ctx.chat!.id);
      if (this.newSessionChats.has(chatId)) {
        resolvedParams.continueSession = false;
        this.newSessionChats.delete(chatId);
      }

      console.log(`Calling MCP tool: ${this.config.target.tool}`);

      // Show "typing..." indicator while waiting for the response
      const typingInterval = setInterval(async () => {
        try {
          await ctx.api.sendChatAction(chatId, "typing");
        } catch { /* ignore errors if chat is unavailable */ }
      }, 4000);
      // Send initial typing action immediately
      await ctx.api.sendChatAction(chatId, "typing").catch(() => {});

      let result: unknown;
      try {
        result = await this.mcpClient.callTool(
          this.config.target.tool,
          resolvedParams as Record<string, unknown>
        );
      } finally {
        clearInterval(typingInterval);
      }
      console.log("MCP tool result:", result);

      // Send result text back to the user
      const content = (result as any)?.content;
      if (Array.isArray(content)) {
        const textParts = content
          .filter((c: any) => c.type === "text" && c.text)
          .map((c: any) => c.text)
          .filter((t: string) => !t.startsWith("[stderr]"));
        const responseText = textParts.join("\n").trim();
        if (responseText) {
          await this.replyWithMarkdown(ctx, responseText);
        }
      }
    } catch (err) {
      console.error("Error calling MCP tool:", err);
    }
  }

  private async replyWithMarkdown(ctx: Context, text: string): Promise<void> {
    try {
      await ctx.reply(escapeMarkdownV2(text), { parse_mode: "MarkdownV2" });
    } catch {
      // Fallback to plain text if MarkdownV2 parsing fails
      await ctx.reply(text);
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
