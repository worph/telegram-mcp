import { z } from "zod";

// Configuration schema
export const TelegramConfigSchema = z.object({
  botToken: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/, "Invalid bot token format"),
  chatId: z.string().optional(),
  mode: z.enum(["polling", "webhook"]).default("polling"),
  webhookUrl: z.string().url().optional(),
}).refine(
  (data) => data.mode !== "webhook" || !!data.webhookUrl || !!process.env.PUBLIC_URL,
  { message: "webhookUrl is required when mode is 'webhook' (or set PUBLIC_URL env)", path: ["webhookUrl"] }
);

export const TargetConfigSchema = z.object({
  transport: z.enum(["http", "sse"]),
  url: z.string().url(),
  tool: z.string().min(1),
  params: z.record(z.any()),
  authToken: z.string().optional(),
});

export const ServerConfigSchema = z.object({
  port: z.number().min(1).max(65535).default(9634),
});

export const ConfigSchema = z.object({
  telegram: TelegramConfigSchema,
  target: TargetConfigSchema,
  server: ServerConfigSchema.optional().default({ port: 9634 }),
});

// Infer types from schemas
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type TargetConfig = z.infer<typeof TargetConfigSchema>;
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

// MCP tool definitions
export interface SendMessageParams {
  chatId?: string;
  text: string;
  parseMode?: "Markdown" | "HTML";
}

export interface SendPhotoParams {
  chatId?: string;
  url: string;
  caption?: string;
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
