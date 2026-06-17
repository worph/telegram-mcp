import { Bot, Context, InlineKeyboard, webhookCallback } from "grammy";
import crypto from "crypto";
import * as os from "os";
import { RequestHandler } from "express";
import { BotStatus, ButtonGrid, Config, MessageContext } from "./types.js";
import { createMessageContext, resolveTemplate } from "./template.js";
import { MCPClientPool } from "./mcp-client.js";
import { PermissionService } from "./permission-service.js";
import { saveConfig, isPlaceholderConfig } from "./config.js";
import { recordMessage } from "./history.js";
import { tryResolveFromMessage } from "./ask-service.js";

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

/**
 * Marker prefixed onto a lock-on-tap button's callback_data so the tap handler
 * can recognise it as one-shot WITHOUT any send-time server state (and therefore
 * survive a bridge restart). It is stripped again before the tap is forwarded to
 * the target MCP, so {{callbackData}} stays clean (`approve`/`cancel`/…). Uses a
 * single non-printing byte that won't collide with real, human-authored payloads.
 */
const LOCK_PREFIX = "\u0001";

/**
 * Convert the generic ButtonGrid used by the MCP tools into the Telegram
 * inline_keyboard shape. Each button becomes either a url button or a
 * callback_data button; callback_data is validated against Telegram's 64-byte
 * limit so callers get a clear error instead of a cryptic API rejection.
 */
function toInlineKeyboard(rows: ButtonGrid): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) keyboard.row();
    for (const btn of row) {
      if (!btn.text) {
        throw new Error("Each inline button requires a non-empty 'text'");
      }
      if (btn.url) {
        keyboard.url(btn.text, btn.url);
        continue;
      }
      const raw = btn.callbackData ?? "";
      // Lock-on-tap buttons carry the marker prefix in their callback_data so the
      // tap handler recognises them statelessly (no send-time registry that a
      // restart could wipe). The marker is stripped before forwarding the tap.
      const data = btn.lockOnTap ? LOCK_PREFIX + raw : raw;
      if (Buffer.byteLength(data, "utf8") > 64) {
        throw new Error(
          `Button '${btn.text}': callbackData exceeds Telegram's 64-byte limit. Keep it short (e.g. a verb + short id) and carry larger context in the message text.`
        );
      }
      keyboard.text(btn.text, data);
    }
  });
  return keyboard;
}

export class TelegramBot {
  private bot: Bot | null = null;
  private config: Config;
  private mcpClient: MCPClientPool | null = null;
  private permissionService: PermissionService | null = null;
  private status: BotStatus = { running: false };
  private isShuttingDown = false;
  private currentMode: "polling" | "webhook" = "polling";
  private webhookMiddleware: RequestHandler | null = null;
  // Chat IDs that should start a new conversation on their next message
  private newSessionChats: Set<string> = new Set();
  // Messages already locked by a first tap, keyed by `${chatId}:${messageId}`.
  // Pure in-process race-guard so simultaneous taps collapse exactly once;
  // lock-ness itself is derived statelessly from the callback_data marker
  // (LOCK_PREFIX), so collapse keeps working across restarts even though this
  // set does not survive one.
  private lockedMessages: Set<string> = new Set();
  private static readonly LOCK_REGISTRY_CAP = 500;

  constructor(config: Config) {
    this.config = config;
  }

  setMCPClient(client: MCPClientPool): void {
    this.mcpClient = client;
  }

  setPermissionService(service: PermissionService): void {
    this.permissionService = service;
  }

  async start(): Promise<void> {
    if (isPlaceholderConfig(this.config)) {
      console.log("Bot not started: bot token not configured. Configure via Web UI.");
      this.status = { running: false, error: "Bot token not configured" };
      return;
    }

    if (this.bot) {
      await this.stop();
    }

    this.isShuttingDown = false;

    // Recover chatId from pending updates before grammY consumes them
    if (!this.config.telegram.chatId) {
      try {
        const resp = await fetch(
          `https://api.telegram.org/bot${this.config.telegram.botToken}/getUpdates?limit=1&offset=-1`
        );
        const data = await resp.json() as { ok: boolean; result: Array<{ message?: { chat: { id: number }; from?: { id: number; username?: string } } }> };
        const pending = data.result?.[0]?.message;
        const chatId = pending && this.isUserAllowed(pending.from?.id, pending.from?.username)
          ? pending.chat.id
          : undefined;
        if (chatId) {
          this.config.telegram.chatId = String(chatId);
          this.status.lastChatId = String(chatId);
          try {
            saveConfig(this.config);
            console.log(`Default chatId recovered from recent updates: ${chatId}`);
          } catch (err) {
            console.warn("Failed to save recovered chatId:", err);
          }
        }
      } catch (err) {
        console.warn("Could not recover chatId from updates:", err);
      }
    }

    this.bot = new Bot(this.config.telegram.botToken);

    // Access control: in private mode only allowed users may interact with the
    // bot (messages, commands, permission buttons), in solo or group chats.
    // Access resolves per chat — a matching per-chat target card supplies its
    // own access rules, otherwise the global telegram access applies.
    this.bot.use(async (ctx, next) => {
      const access = this.resolveAccess(ctx.chat?.id);
      if (this.isUserAllowed(ctx.from?.id, ctx.from?.username, access)) {
        return next();
      }
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Not authorized" }).catch(() => {});
        return;
      }
      // Reply with the user ID in direct chats so the owner can onboard
      // themselves; stay silent in groups to avoid spamming members.
      if (ctx.message && ctx.chat?.type === "private") {
        await ctx.reply(
          `⛔ This bot is private.\nYour user ID: ${ctx.from?.id}\n` +
          `Ask the bot owner to add you to the allowed users list.`
        ).catch(() => {});
      }
    });

    // Handle /mcp command - show connection status
    this.bot.command("mcp", async (ctx) => {
      if (!this.mcpClient) {
        await ctx.reply("MCP client not configured.");
        return;
      }
      // Resolve the target this specific chat routes to (a chatTargets override
      // or the catch-all default), so /mcp reflects where *this* chat goes.
      const { client } = this.mcpClient.resolve(ctx.chat.id);
      const connected = client.isConnected();
      const { url, tool } = client.getTargetInfo();
      const isOverride = this.config.chatTargets.some((t) =>
        t.chatIds.map(String).includes(String(ctx.chat.id))
      );
      const routing = isOverride ? "per-chat target" : "default target";
      const status = connected ? "🟢 Connected" : "🔴 Disconnected";
      await ctx.reply(
        `*MCP Status*\n\n${status}\n\n*Endpoint:* \`${url}\`\n*Tool:* \`${tool}\`\n*Routing:* ${routing}`,
        { parse_mode: "Markdown" }
      );
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
        await ctx.reply(`Revoked always-allow for: ${revoked.map((t: string) => `\`${t}\``).join(", ")}`, { parse_mode: "Markdown" });
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

    // Generic inline-button taps (anything that is not a `perm:` permission
    // button, which is handled above and short-circuits). These are acknowledged
    // immediately to stop the client spinner, then forwarded to the target MCP
    // through the same path as text messages, exposing {{callbackData}} etc.
    this.bot.on("callback_query:data", async (ctx) => {
      const chatId = String(ctx.callbackQuery.message?.chat.id ?? ctx.chat?.id ?? "");
      const messageId = ctx.callbackQuery.message?.message_id;
      const data = ctx.callbackQuery.data;

      // Lock-on-tap button: recognised statelessly from the callback_data marker
      // (so it survives a bridge restart). Lock the message server-side before
      // forwarding, so the action is single-shot and the user instantly sees
      // their choice. The marker is stripped before forwarding in handleCallbackQuery.
      if (data.startsWith(LOCK_PREFIX) && chatId && messageId) {
        const key = `${chatId}:${messageId}`;
        if (this.lockedMessages.has(key)) {
          // Already taken by an earlier tap in this process — swallow the duplicate.
          await ctx.answerCallbackQuery().catch(() => {});
          return;
        }
        this.markMessageLocked(key); // set before any await to win double-tap races
        await ctx.answerCallbackQuery().catch(() => {});
        await this.lockMessageToChoice(ctx, data).catch((err) =>
          console.error("Failed to lock message to chosen option:", err)
        );
        this.handleCallbackQuery(ctx).catch((err) => {
          console.error("Error in handleCallbackQuery:", err);
        });
        return;
      }

      try {
        await ctx.answerCallbackQuery();
      } catch {
        // Query may be too old to answer — proceed with forwarding anyway.
      }
      // Fire-and-forget for the same anti-deadlock reason as text messages.
      this.handleCallbackQuery(ctx).catch((err) => {
        console.error("Error in handleCallbackQuery:", err);
      });
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

      this.currentMode = this.config.telegram.mode || "polling";

      if (this.currentMode === "webhook") {
        const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, "");
        const webhookUrl = this.config.telegram.webhookUrl
          || (publicUrl ? `${publicUrl}/webhook` : null);
        if (!webhookUrl) {
          throw new Error("Webhook mode requires webhookUrl in config or PUBLIC_URL env var");
        }
        const secretToken = crypto.randomUUID();
        await this.bot.api.setWebhook(webhookUrl, { secret_token: secretToken });
        this.webhookMiddleware = webhookCallback(this.bot, "express", { secretToken });
        console.log(`Bot webhook set to ${webhookUrl}`);
      } else {
        // Clear any stale webhook when switching to polling
        await this.bot.api.deleteWebhook();
        this.webhookMiddleware = null;
        this.bot.start({
          drop_pending_updates: true,
          onStart: () => {
            console.log("Bot polling started");
          },
        }).catch((err) => {
          console.error("Bot polling stopped with error:", err instanceof Error ? err.message : err);
          this.status.running = false;
          this.status.error = String(err);
        });
      }
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
      if (this.currentMode === "webhook") {
        try {
          await this.bot.api.deleteWebhook();
        } catch (err) {
          console.warn("Failed to delete webhook on stop:", err);
        }
      }
      await this.bot.stop();
      this.bot = null;
      this.webhookMiddleware = null;
      this.status.running = false;
      console.log("Bot stopped");
    }
  }

  getWebhookMiddleware(): RequestHandler | null {
    return this.webhookMiddleware;
  }

  getStatus(): BotStatus {
    return { ...this.status };
  }

  getBot(): Bot | null {
    return this.bot;
  }

  getDefaultChatId(): string | undefined {
    return this.config.telegram.chatId;
  }

  getLastChatId(): string | undefined {
    return this.status.lastChatId;
  }

  updateConfig(config: Config): void {
    this.config = config;
  }

  /**
   * Resolve the access rules that apply to a chat: the first per-chat target
   * card whose chatIds lists the chat (and that defines its own access), else
   * the global telegram access.
   */
  private resolveAccess(
    chatId?: number | string
  ): { accessMode: "public" | "private"; allowedUsers: string[] } {
    if (chatId !== undefined) {
      const id = String(chatId);
      const card = this.config.chatTargets.find((t) => t.chatIds.map(String).includes(id));
      if (card && card.accessMode !== undefined) {
        return { accessMode: card.accessMode, allowedUsers: card.allowedUsers ?? [] };
      }
    }
    return {
      accessMode: this.config.telegram.accessMode,
      allowedUsers: this.config.telegram.allowedUsers ?? [],
    };
  }

  /**
   * Check whether a Telegram user may use the bot under the given access rules
   * (defaults to the global telegram access). Public mode allows everyone;
   * private mode requires a match in allowedUsers, where entries are numeric
   * user IDs or usernames (with or without @, case-insensitive).
   */
  private isUserAllowed(
    userId?: number | string,
    username?: string,
    access?: { accessMode: "public" | "private"; allowedUsers: string[] }
  ): boolean {
    const rules = access ?? this.resolveAccess();
    if (rules.accessMode === "public") {
      return true;
    }
    const uid = userId !== undefined ? String(userId) : undefined;
    const uname = username?.toLowerCase();
    return rules.allowedUsers.some((entry) => {
      const e = entry.trim();
      if (!e) return false;
      if (/^\d+$/.test(e)) return e === uid;
      return e.replace(/^@/, "").toLowerCase() === uname;
    });
  }

  private async handleTextMessage(ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!message || !message.text || !message.from) {
      return;
    }

    this.status.lastMessageAt = Date.now();
    this.status.lastChatId = String(message.chat.id);

    // Auto-save chatId to config on first message so it persists across restarts
    if (!this.config.telegram.chatId) {
      this.config.telegram.chatId = String(message.chat.id);
      try {
        saveConfig(this.config);
        console.log(`Default chatId saved to config: ${message.chat.id}`);
      } catch (err) {
        console.warn("Failed to auto-save chatId to config:", err);
      }
    }

    const localUrl = `http://${os.hostname()}:${process.env.PORT || 9634}`;
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
      message.from.language_code,
      `${localUrl}/api/permission`,
      this.config.telegram.chatId
    );

    console.log(`Received message from ${messageContext.username || messageContext.userId}: ${messageContext.text}`);

    // Record the incoming message so the LLM can later pull it via get_chat_history
    recordMessage(String(message.chat.id), {
      role: "user",
      name: messageContext.username || messageContext.firstName,
      text: message.text,
      date: message.date,
    });

    // If this message answers a pending `ask` question, it is consumed by the
    // ask flow instead of being forwarded to the target MCP.
    if (
      tryResolveFromMessage(String(message.chat.id), message.text, {
        replyToMessageId: message.reply_to_message?.message_id,
        answeredBy: messageContext.username || messageContext.firstName,
      })
    ) {
      console.log(`Message consumed as answer to a pending ask question`);
      // Acknowledge so the user knows the answer was captured even if the
      // asking LLM is not actively polling right now.
      try {
        await ctx.react("👍");
      } catch {
        await ctx.reply("✅").catch(() => {});
      }
      return;
    }

    await this.dispatchToTarget(ctx, messageContext, String(message.chat.id));
  }

  /**
   * Handle an inline-button tap: build a MessageContext carrying the callback
   * fields ({{callbackData}}, {{callbackQueryId}}, {{callbackMessageId}},
   * {{callbackMessageText}}) and forward it to the target MCP, exactly like a
   * text message. `text` is set to the callbackData so configs that template on
   * {{text}} keep working without changes.
   */
  private async handleCallbackQuery(ctx: Context): Promise<void> {
    const query = ctx.callbackQuery;
    if (!query || !query.data || !query.from) {
      return;
    }
    const msg = query.message;
    const chatId = String(msg?.chat.id ?? ctx.chat?.id ?? "");
    if (!chatId) {
      console.warn("Callback query without a resolvable chat id, ignoring");
      return;
    }

    // Strip the lock-on-tap marker so the target MCP sees the clean payload
    // (e.g. `approve`/`cancel`), never the internal prefix.
    const data = query.data.startsWith(LOCK_PREFIX) ? query.data.slice(LOCK_PREFIX.length) : query.data;

    this.status.lastMessageAt = Date.now();
    this.status.lastChatId = chatId;

    const callbackMessageText = msg && "text" in msg ? (msg.text ?? "") : "";

    console.log(`Received button tap from ${query.from.username || query.from.id}: ${data}`);

    // Record the tap so it shows up in get_chat_history as conversation context.
    recordMessage(chatId, {
      role: "user",
      name: query.from.username || query.from.first_name,
      text: `[button] ${data}`,
      date: Math.floor(Date.now() / 1000),
    });

    const localUrl = `http://${os.hostname()}:${process.env.PORT || 9634}`;
    const messageContext: MessageContext = createMessageContext(
      data,
      chatId,
      query.from.id,
      query.from.username,
      query.from.first_name,
      query.from.last_name,
      msg?.message_id ?? 0,
      Math.floor(Date.now() / 1000),
      query.from.is_bot,
      query.from.language_code,
      `${localUrl}/api/permission`,
      this.config.telegram.chatId,
      {
        data,
        queryId: query.id,
        messageId: msg?.message_id,
        messageText: callbackMessageText,
      }
    );

    await this.dispatchToTarget(ctx, messageContext, chatId, true);
  }

  /**
   * Resolve the target params against the given context, call the target MCP
   * tool, and reply to the chat with its text output. Shared by the text-message
   * and inline-button (callback query) paths.
   */
  private async dispatchToTarget(
    ctx: Context,
    messageContext: MessageContext,
    chatId: string,
    isCallback = false
  ): Promise<void> {
    if (!this.mcpClient) {
      console.warn("MCP client not set, skipping tool call");
      return;
    }

    // Pick the target for this chat: a per-chat override if one lists this
    // chat, otherwise the catch-all default.
    const { client, target } = this.mcpClient.resolve(chatId);

    try {
      // Resolve the prompt template first (expanding its own {{vars}}) and expose
      // it as {{template}} so params reference the text once instead of inlining it.
      const promptTemplate = target.promptTemplate;
      messageContext.template = promptTemplate
        ? (resolveTemplate(promptTemplate, messageContext) as string)
        : messageContext.text;

      const resolvedParams = resolveTemplate(
        target.params,
        messageContext
      ) as Record<string, unknown>;

      // If /new was used, start a fresh session and consume the flag
      if (this.newSessionChats.has(chatId)) {
        resolvedParams.continueSession = false;
        this.newSessionChats.delete(chatId);
      }

      console.log(`Calling MCP tool: ${target.tool} (${target.url})`);

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
        result = await client.callTool(
          target.tool,
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
        // For inline-button (callback) events the target agent sends its own
        // messages via send_message/edit_message, so don't echo its return value
        // back into the chat — it just duplicates/adds noise. Text messages still
        // get the reply.
        if (responseText && !isCallback) {
          await this.replyWithMarkdown(ctx, responseText);
        }
      }
    } catch (err) {
      console.error("Error calling MCP tool:", err);
    }
  }

  private async replyWithMarkdown(ctx: Context, text: string): Promise<void> {
    if (ctx.chat) {
      recordMessage(String(ctx.chat.id), {
        role: "assistant",
        text,
        date: Math.floor(Date.now() / 1000),
      });
    }
    try {
      await ctx.reply(escapeMarkdownV2(text), { parse_mode: "MarkdownV2" });
    } catch {
      // Fallback to plain text if MarkdownV2 parsing fails
      await ctx.reply(text);
    }
  }

  /**
   * Mark a message as locked after its first lock-on-tap tap, so a near-
   * simultaneous second tap in the same process is swallowed. This is only a
   * race-guard — whether a button is lock-on-tap is decided statelessly from the
   * callback_data marker, so losing this set on restart never re-enables a
   * second tap (the message's keyboard is already gone, or gets collapsed again).
   */
  private markMessageLocked(key: string): void {
    this.lockedMessages.add(key);
    // Bound memory: Set preserves insertion order, so drop the oldest entries.
    while (this.lockedMessages.size > TelegramBot.LOCK_REGISTRY_CAP) {
      const oldest = this.lockedMessages.values().next().value;
      if (oldest === undefined) break;
      this.lockedMessages.delete(oldest);
    }
  }

  /**
   * Lock a tapped message: remove its keyboard entirely (so nothing stays
   * tappable) and append the chosen option as a plain "✓ <choice>" line so the
   * decision is still visible. Reads the button label from the message's current
   * keyboard. Falls back to just stripping the buttons when there's no text to
   * edit (e.g. a photo caption).
   */
  private async lockMessageToChoice(ctx: Context, chosenData: string): Promise<void> {
    const message = ctx.callbackQuery?.message;
    const rows = message?.reply_markup?.inline_keyboard;
    let chosenText: string | undefined;
    for (const row of rows ?? []) {
      for (const btn of row) {
        if ("callback_data" in btn && btn.callback_data === chosenData) {
          chosenText = btn.text;
        }
      }
    }
    const choiceLine = `✓ ${chosenText ?? "Done"}`;
    const original = message && "text" in message ? message.text : undefined;
    if (original !== undefined) {
      // Omitting reply_markup removes the keyboard; the appended line records
      // the choice as plain (non-clickable) text.
      await ctx.editMessageText(`${original}\n\n${choiceLine}`);
    } else {
      await ctx.editMessageReplyMarkup();
    }
  }

  async sendMessage(
    chatId: string,
    text: string,
    parseMode?: "Markdown" | "HTML",
    buttons?: ButtonGrid,
    disablePreview?: boolean
  ): Promise<number> {
    if (!this.bot) {
      throw new Error("Bot not running");
    }

    const msg = await this.bot.api.sendMessage(chatId, text, {
      parse_mode: parseMode,
      reply_markup: buttons && buttons.length > 0 ? toInlineKeyboard(buttons) : undefined,
      link_preview_options: disablePreview ? { is_disabled: true } : undefined,
    });
    recordMessage(chatId, {
      role: "assistant",
      text,
      date: Math.floor(Date.now() / 1000),
    });
    return msg.message_id;
  }

  /**
   * Edit a previously sent message's text and/or inline buttons. Passing
   * `buttons` omitted removes the keyboard (used to "lock" an approval message
   * after a decision). At least one of text/buttons should be provided.
   */
  async editMessage(
    chatId: string,
    messageId: number,
    opts: { text?: string; parseMode?: "Markdown" | "HTML"; buttons?: ButtonGrid; disablePreview?: boolean }
  ): Promise<void> {
    if (!this.bot) {
      throw new Error("Bot not running");
    }

    const replyMarkup = opts.buttons && opts.buttons.length > 0 ? toInlineKeyboard(opts.buttons) : undefined;

    if (opts.text !== undefined) {
      // reply_markup: undefined removes any existing keyboard.
      await this.bot.api.editMessageText(chatId, messageId, opts.text, {
        parse_mode: opts.parseMode,
        reply_markup: replyMarkup,
        link_preview_options: opts.disablePreview ? { is_disabled: true } : undefined,
      });
      recordMessage(chatId, {
        role: "assistant",
        text: opts.text,
        date: Math.floor(Date.now() / 1000),
      });
    } else {
      await this.bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: replyMarkup });
    }
  }

  /**
   * Send a question with ForceReply so Telegram clients prompt the user for
   * an answer. Returns the Telegram message id, used to match the reply.
   */
  async sendQuestion(chatId: string, question: string): Promise<number> {
    if (!this.bot) {
      throw new Error("Bot not running");
    }

    const msg = await this.bot.api.sendMessage(chatId, `❓ ${question}`, {
      reply_markup: { force_reply: true, input_field_placeholder: "Type your answer…" },
    });
    recordMessage(chatId, {
      role: "assistant",
      text: `❓ ${question}`,
      date: Math.floor(Date.now() / 1000),
    });
    return msg.message_id;
  }

  async sendPhoto(chatId: string, url: string, caption?: string): Promise<void> {
    if (!this.bot) {
      throw new Error("Bot not running");
    }

    await this.bot.api.sendPhoto(chatId, url, caption ? { caption } : undefined);
  }
}
