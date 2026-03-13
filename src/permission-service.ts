import { InlineKeyboard } from "grammy";
import { TelegramBot } from "./bot";
import {
  PendingPermission,
  PermissionRequest,
  PermissionResponse,
} from "./types";

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
      console.log(`Auto-allowing ${req.toolName} (in allowlist)`);
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
      console.log(`Added ${pending.toolName} to allowlist (now: ${[...this.allowedTools].join(", ")})`);
    }

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
    console.log("Cleared tool allowlist");
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
