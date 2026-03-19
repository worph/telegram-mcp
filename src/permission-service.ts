import crypto from "crypto";
import { Response } from "express";
import { InlineKeyboard } from "grammy";
import { TelegramBot } from "./bot.js";
import {
  PendingPermission,
  PermissionRequest,
  PermissionResponse,
  WebPermissionRequest,
} from "./types.js";

const DEFAULT_PERMISSION_TIMEOUT = 120; // seconds

export class PermissionService {
  private pending: Map<string, PendingPermission> = new Map();
  private allowedTools: Set<string> = new Set();
  private bot: TelegramBot | null = null;

  setBot(bot: TelegramBot): void {
    this.bot = bot;
  }

  async requestPermission(req: PermissionRequest): Promise<PermissionResponse> {
    if (!this.bot) {
      throw new Error("Bot not set on PermissionService");
    }

    const botInstance = this.bot.getBot();
    if (!botInstance) {
      throw new Error("Bot not running");
    }

    // Auto-allow if tool is in the allowlist
    if (this.allowedTools.has(req.toolName)) {
      console.log(`[permission:telegram] Auto-allowed tool=${req.toolName} queryId=${req.queryId} chatId=${req.chatId} (in allowlist)`);
      return {
        queryId: req.queryId,
        decision: "allow",
        timedOut: false,
      };
    }

    // Check if there's already a pending permission for this queryId
    if (this.pending.has(req.queryId)) {
      throw new Error(`Permission request already pending for queryId: ${req.queryId}`);
    }

    const timeout = (req.timeout || DEFAULT_PERMISSION_TIMEOUT) * 1000;

    // Format the permission message
    const toolInputStr = JSON.stringify(req.toolInput, null, 2);
    const truncatedInput = toolInputStr.length > 500
      ? toolInputStr.substring(0, 500) + "..."
      : toolInputStr;

    const messageText =
      `**Permission Required**\n\n` +
      `Tool: \`${req.toolName}\`\n\n` +
      (req.description ? `${req.description}\n\n` : "") +
      `Input:\n\`\`\`\n${truncatedInput}\n\`\`\``;

    // Create inline keyboard with Allow/Deny/Always Allow buttons
    const keyboard = new InlineKeyboard()
      .text("Allow", `perm:allow:${req.queryId}`)
      .text("Deny", `perm:deny:${req.queryId}`)
      .row()
      .text(`Always Allow ${req.toolName}`, `perm:always:${req.queryId}`);

    // Send message with keyboard
    const message = await botInstance.api.sendMessage(
      req.chatId,
      messageText,
      {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      }
    );

    return new Promise<PermissionResponse>((resolve, reject) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        this.handleTimeout(req.queryId);
      }, timeout);

      // Store pending permission
      const pending: PendingPermission = {
        queryId: req.queryId,
        chatId: req.chatId,
        messageId: message.message_id,
        toolName: req.toolName,
        resolve,
        reject,
        timeoutId,
      };

      this.pending.set(req.queryId, pending);
    });
  }

  async resolvePermission(queryId: string, decision: "allow" | "deny" | "always"): Promise<boolean> {
    const pending = this.pending.get(queryId);
    if (!pending) {
      console.warn(`No pending permission found for queryId: ${queryId}`);
      return false;
    }

    // Clear timeout
    clearTimeout(pending.timeoutId);

    // Remove from pending
    this.pending.delete(queryId);

    // If "always", add to allowlist
    if (decision === "always") {
      this.allowedTools.add(pending.toolName);
      console.log(`[permission:telegram] Always-allow added: tool=${pending.toolName} allowlist=[${[...this.allowedTools].join(", ")}]`);
    }

    console.log(`[permission:telegram] Resolved: queryId=${queryId} tool=${pending.toolName} chatId=${pending.chatId} decision=${decision}`);

    // Resolve the promise (always/allow both grant permission)
    pending.resolve({
      queryId,
      decision: decision === "always" ? "allow" : decision,
      timedOut: false,
    });

    // Update message
    await this.updateMessage(pending.chatId, pending.messageId, decision, pending.toolName);

    return true;
  }

  revokeAllowedTools(): string[] {
    const tools = [...this.allowedTools];
    this.allowedTools.clear();
    console.log(`[permission:telegram] Allowlist revoked: tools=[${tools.join(", ")}]`);
    return tools;
  }

  getAllowedTools(): string[] {
    return [...this.allowedTools];
  }

  private async handleTimeout(queryId: string): Promise<void> {
    const pending = this.pending.get(queryId);
    if (!pending) {
      return;
    }

    // Remove from pending
    this.pending.delete(queryId);

    console.log(`[permission:telegram] Timed out: queryId=${queryId} tool=${pending.toolName} chatId=${pending.chatId}`);

    // Resolve with timeout/deny
    pending.resolve({
      queryId,
      decision: "deny",
      timedOut: true,
    });

    // Update message to show timeout
    await this.updateMessage(pending.chatId, pending.messageId, "timeout", pending.toolName);
  }

  private async updateMessage(
    chatId: string,
    messageId: number,
    outcome: "allow" | "deny" | "always" | "timeout",
    toolName: string
  ): Promise<void> {
    if (!this.bot) return;

    const botInstance = this.bot.getBot();
    if (!botInstance) return;

    let text: string;
    switch (outcome) {
      case "allow":
        text = `\u2705 \`${toolName}\` authorized`;
        break;
      case "always":
        text = `\u2705 \`${toolName}\` authorized (always)`;
        break;
      case "deny":
        text = `\u274c \`${toolName}\` denied`;
        break;
      case "timeout":
        text = `\u23f0 \`${toolName}\` timed out (denied)`;
        break;
    }

    try {
      await botInstance.api.editMessageText(chatId, messageId, text, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("Failed to update permission message:", err);
    }
  }

  // Get count of pending permissions (for status/debugging)
  getPendingCount(): number {
    return this.pending.size;
  }

  // Check if a permission is pending
  hasPending(queryId: string): boolean {
    return this.pending.has(queryId);
  }
}

const WEB_PERMISSION_TIMEOUT = 60; // seconds

interface PendingWebPermission {
  resolve: (response: PermissionResponse) => void;
  timeoutId: NodeJS.Timeout;
}

export class WebPermissionService {
  private sseClient: Response | null = null;
  private csrfToken: string | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private pending: Map<string, PendingWebPermission> = new Map();

  connectClient(res: Response): void {
    // Deny any pending from previous client
    if (this.sseClient) {
      console.log(`[permission:web] Previous SSE client replaced — denying ${this.pending.size} pending request(s)`);
      this.denyAllPending("Browser reconnected — previous session terminated");
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    this.sseClient = res;
    this.csrfToken = crypto.randomBytes(32).toString("hex");

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Send CSRF token as first event
    this.sendEvent(res, "csrf", { token: this.csrfToken });

    // Keep-alive ping every 25s
    this.pingInterval = setInterval(() => {
      if (this.sseClient === res) {
        this.sendEvent(res, "ping", {});
      }
    }, 25_000);

    // On disconnect, deny all pending
    res.on("close", () => {
      if (this.sseClient === res) {
        this.sseClient = null;
        this.csrfToken = null;
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
        this.denyAllPending("Browser disconnected");
      }
    });
  }

  async requestPermission(req: WebPermissionRequest): Promise<PermissionResponse> {
    if (!this.sseClient) {
      console.log(`[permission:web] No SSE client connected — auto-denying: queryId=${req.queryId} tool=${req.toolName}`);
      return { queryId: req.queryId, decision: "deny", timedOut: true };
    }
    console.log(`[permission:web] Sending prompt to browser: queryId=${req.queryId} tool=${req.toolName} timeout=${req.timeout || WEB_PERMISSION_TIMEOUT}s input=${JSON.stringify(req.toolInput)}`);

    const timeout = (req.timeout || WEB_PERMISSION_TIMEOUT) * 1000;

    const event: WebPermissionRequest = {
      queryId: req.queryId,
      toolName: req.toolName,
      toolInput: req.toolInput,
      description: req.description,
      timeout: req.timeout || WEB_PERMISSION_TIMEOUT,
    };
    this.sendEvent(this.sseClient, "permission", event);

    return new Promise<PermissionResponse>((resolve) => {
      const timeoutId = setTimeout(() => {
        if (this.pending.has(req.queryId)) {
          this.pending.delete(req.queryId);
          console.log(`[permission:web] Timed out: queryId=${req.queryId} tool=${req.toolName}`);
          resolve({ queryId: req.queryId, decision: "deny", timedOut: true });
        }
      }, timeout);

      this.pending.set(req.queryId, { resolve, timeoutId });
    });
  }

  resolvePermission(queryId: string, decision: "allow" | "deny"): boolean {
    const pending = this.pending.get(queryId);
    if (!pending) {
      console.log(`[permission:web] Resolve failed — no pending request: queryId=${queryId}`);
      return false;
    }
    clearTimeout(pending.timeoutId);
    this.pending.delete(queryId);
    console.log(`[permission:web] Resolved: queryId=${queryId} decision=${decision}`);
    pending.resolve({ queryId, decision, timedOut: false });
    return true;
  }

  validateCsrfToken(token: string): boolean {
    if (!this.csrfToken) return false;
    try {
      const a = Buffer.from(token);
      const b = Buffer.from(this.csrfToken);
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  isClientConnected(): boolean {
    return this.sseClient !== null;
  }

  private denyAllPending(reason: string): void {
    console.log(`[permission:web] Denying ${this.pending.size} pending request(s) — ${reason}`);
    for (const [queryId, pending] of this.pending) {
      clearTimeout(pending.timeoutId);
      pending.resolve({ queryId, decision: "deny", timedOut: false });
    }
    this.pending.clear();
  }

  private sendEvent(res: Response, event: string, data: unknown): void {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      console.error("Failed to write SSE event:", err);
    }
  }
}
