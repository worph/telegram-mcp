import { z } from "zod";

// Configuration schema
export const TelegramConfigSchema = z.object({
  botToken: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/, "Invalid bot token format"),
  mode: z.enum(["polling", "webhook"]).default("polling"),
  webhookUrl: z.string().url().optional(),
});

export const TargetConfigSchema = z.object({
  transport: z.enum(["http", "sse"]),
  url: z.string().url(),
  tool: z.string().min(1),
  params: z.record(z.any()),
  authToken: z.string().optional(),
});

export const ServerConfigSchema = z.object({
  port: z.number().min(1).max(65535).default(8080),
});

export const ConfigSchema = z.object({
  telegram: TelegramConfigSchema,
  target: TargetConfigSchema,
  server: ServerConfigSchema.optional().default({ port: 8080 }),
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
}

// Bot status
export interface BotStatus {
  running: boolean;
  botUsername?: string;
  error?: string;
  lastMessageAt?: number;
}

// MCP tool definitions
export interface SendMessageParams {
  chatId: string;
  text: string;
  parseMode?: "Markdown" | "HTML";
}

export interface SendPhotoParams {
  chatId: string;
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
