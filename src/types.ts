import { z } from "zod";

// Configuration schema
export const TelegramConfigSchema = z.object({
  botToken: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/, "Invalid bot token format"),
  chatId: z.string().optional(),
  mode: z.enum(["polling", "webhook"]).default(process.env.PUBLIC_URL ? "webhook" : "polling"),
  webhookUrl: z.string().url().optional(),
  // Access control. "private" (default): only users in allowedUsers may use the bot.
  accessMode: z.enum(["public", "private"]).default("private"),
  // Numeric user IDs or usernames (with or without @), case-insensitive.
  allowedUsers: z.array(z.string()).default([]),
}).refine(
  (data) => data.mode !== "webhook" || !!data.webhookUrl || !!process.env.PUBLIC_URL,
  { message: "webhookUrl is required when mode is 'webhook' (or set PUBLIC_URL env)", path: ["webhookUrl"] }
);

export const TargetConfigSchema = z.object({
  transport: z.literal("http"),
  url: z.string().url(),
  tool: z.string().min(1),
  params: z.record(z.any()),
  authToken: z.string().optional(),
  // Optional prompt template. When set, params can reference it via {{template}};
  // it is resolved (its own {{vars}} expanded) before being substituted in.
  promptTemplate: z.string().optional(),
});

// A per-chat target override: a full TargetConfig plus the list of chat IDs it
// serves. The first chatTargets entry whose `chatIds` contains the incoming
// chat wins; if none match, the top-level `target` is used as the catch-all
// default. Each entry is a complete, independent target — it can point at a
// different MCP server entirely, or the same server with a different tool,
// params, prompt, or auth.
export const ChatTargetSchema = TargetConfigSchema.extend({
  chatIds: z.array(z.string().min(1)).min(1),
  // Per-card access control, scoped to this card's chats. Mirrors the global
  // telegram access (public/private + allowedUsers). When omitted, the global
  // telegram access applies to these chats.
  accessMode: z.enum(["public", "private"]).optional(),
  allowedUsers: z.array(z.string()).optional(),
});

export const ServerConfigSchema = z.object({
  port: z.number().min(1).max(65535).default(9634),
});

export const ConfigSchema = z.object({
  telegram: TelegramConfigSchema,
  target: TargetConfigSchema,
  // Optional per-chat target overrides. Matched before the catch-all `target`.
  chatTargets: z.array(ChatTargetSchema).default([]),
  server: ServerConfigSchema.optional().default({ port: 9634 }),
});

// Infer types from schemas
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type TargetConfig = z.infer<typeof TargetConfigSchema>;
export type ChatTargetConfig = z.infer<typeof ChatTargetSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

// Message context for template resolution
export interface MessageContext {
  text: string;
  chatId: string;
  userId: string;
  username: string | undefined;
  firstName: string;
  lastName: string | undefined;
  messageId: number;
  date: number;
  isBot: boolean;
  languageCode: string | undefined;
  permissionCallbackUrl?: string;
  defaultChatId?: string;
  // Resolved prompt template, exposed so params can reference it via {{template}}
  template?: string;
  // Set only when the update is an inline-button tap (callback query). These are
  // exposed as {{callbackData}}, {{callbackQueryId}}, {{callbackMessageId}} and
  // {{callbackMessageText}} so target params can route on a button press.
  callbackData?: string;
  callbackQueryId?: string;
  callbackMessageId?: number;
  callbackMessageText?: string;
}

// Web permission SSE event payload
export interface WebPermissionRequest {
  queryId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  description?: string;
  timeout?: number;
}

// Browser POST body for resolving a web permission
export interface WebPermissionResolveBody {
  queryId: string;
  decision: "allow" | "deny";
  csrfToken: string;
}

// Bot status
export interface BotStatus {
  running: boolean;
  botUsername?: string;
  error?: string;
  lastMessageAt?: number;
  lastChatId?: string;
}

// A single inline-keyboard button. Exactly one action should be set: a
// `callbackData` button taps back to the bot (and is forwarded to the target
// MCP), a `url` button opens a link. callbackData is opaque to the bridge and
// must be <= 64 bytes (Telegram limit).
export interface InlineButton {
  text: string;
  callbackData?: string;
  url?: string;
  // When true (callbackData buttons only), the first tap locks the message
  // server-side: the keyboard collapses to show just the chosen option and
  // further taps are ignored, all before the tap is forwarded to the target
  // MCP. Use for one-shot Approve/Decline prompts; leave unset for menus.
  lockOnTap?: boolean;
}

// Rows of inline buttons (a Telegram inline keyboard is a 2D grid).
export type ButtonGrid = InlineButton[][];

// MCP tool definitions
export interface SendMessageParams {
  chatId?: string;
  text: string;
  parseMode?: "Markdown" | "HTML";
  buttons?: ButtonGrid;
  // When true, suppress Telegram's auto link preview (the big unfurled card).
  disablePreview?: boolean;
}

export interface EditMessageParams {
  chatId?: string;
  messageId: number;
  text?: string;
  parseMode?: "Markdown" | "HTML";
  buttons?: ButtonGrid;
  disablePreview?: boolean;
}

export interface SendPhotoParams {
  chatId?: string;
  url: string;
  caption?: string;
}

export interface AskParams {
  question: string;
  chatId?: string;
  timeoutSeconds?: number;
  waitSeconds?: number;
}

export interface GetAnswerParams {
  questionId?: string;
  chatId?: string;
  waitSeconds?: number;
}

// Permission request from claude-code-container
export interface PermissionRequest {
  queryId: string;
  chatId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  description?: string;
  timeout?: number;
}

// Permission response back to claude-code-container
export interface PermissionResponse {
  queryId: string;
  decision: "allow" | "deny";
  timedOut?: boolean;
}

// Internal pending permission tracking
export interface PendingPermission {
  queryId: string;
  chatId: string;
  messageId: number;
  toolName: string;
  resolve: (response: PermissionResponse) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

// Handle permission tool params
export interface HandlePermissionParams {
  queryId: string;
  chatId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  description?: string;
  timeout?: number;
}
