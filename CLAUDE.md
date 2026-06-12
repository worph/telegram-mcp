# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Run Commands

```bash
pnpm install          # Install dependencies
pnpm run build        # Compile TypeScript to dist/ (runs tsc)
pnpm start            # Run compiled output (node dist/index.js)
pnpm run dev          # Watch mode (tsc --watch)
pnpm run clean        # Remove dist/
```

Docker deployment:
```bash
docker compose up -d          # Start
docker compose up --build -d  # Rebuild and restart
docker compose down           # Stop
```

There are no tests or linting configured in this project.

## Architecture

Bidirectional Telegram-MCP bridge: acts as both an **MCP server** (exposing Telegram tools to LLMs) and an **MCP client** (forwarding Telegram messages to a target MCP server).

### Data Flow

1. Telegram message → `TelegramBot` (grammY polling/webhook) → resolves `{{variable}}` templates in target params
2. `MCPClient.callTool()` forwards resolved params to the configured target MCP server
3. Target LLM processes the message, calls back via `send_message`/`send_photo` tools on this server's MCP endpoint
4. `MCPServer` handles the tool call → `TelegramBot.sendMessage()` replies to the user

### Key Components

- **`src/index.ts`** — Entry point. Wires together bot, MCP client/server, permission services, Express API. Handles graceful shutdown and restart logic.
- **`src/bot.ts`** — grammY bot with commands (`/start`, `/new`, `/mcp`, `/revoke`). `handleTextMessage()` is fire-and-forget (not awaited) to avoid deadlock with permission callback queries. Includes MarkdownV2 escaping for replies.
- **`src/mcp-server.ts`** — Exposes tools (`send_message`, `send_photo`, `ask`, `get_answer`, `echo`, `mcp_info`, `get_chat_history`) via stateless Streamable HTTP POST (`/mcp`). Each request gets its own `Server` instance.
- **`src/mcp-client.ts`** — Connects to the target MCP server via Streamable HTTP transport. Wraps transport to suppress `notifications/initialized` errors. Auto-reconnects on `callTool()` if disconnected. 3-minute timeout on tool calls to allow for permission prompts.
- **`src/api.ts`** — Express app factory. Mounts MCP router at `/mcp` **before** JSON middleware (MCP needs raw body). REST endpoints under `/api/` for config, status, restart, permission handling, and MCP server info.
- **`src/permission-service.ts`** — Two services: `PermissionService` (Telegram inline keyboard flow) and `WebPermissionService` (SSE-based browser flow with CSRF protection). Permission routing is based on `chatId`: empty → web, otherwise → Telegram.
- **`src/ask-service.ts`** — In-memory registry for human-in-the-loop questions (`ask`/`get_answer` tools): question lifecycle (pending → answered/expired), long-poll waiters, 24h max TTL, purge ~1h after expiry.
- **`src/template.ts`** — Recursively resolves `{{variable}}` placeholders in config params against `MessageContext`.
- **`src/types.ts`** — Zod schemas for config validation (`ConfigSchema`, `TelegramConfigSchema`, `TargetConfigSchema`) and TypeScript interfaces.
- **`src/mcp-info.ts`** — Generates Markdown-formatted MCP connection info text.
- **`web/`** — Static Web UI for runtime configuration, served at `/`.

### Configuration

`config.json` (validated by Zod schemas in `types.ts`):
- `telegram` — Bot token, mode (`polling`|`webhook`), optional `webhookUrl`, `accessMode` (`private` default | `public`), `allowedUsers` (user IDs or usernames; enforced by a grammY middleware in `bot.ts` that gates all updates, and by the startup chatId-recovery logic)
- `target` — MCP client settings: transport (`http`), url, tool name, parameter mappings with `{{variable}}` templates
- `server` — Web UI port (default 9634)

The Web UI allows editing config at runtime. `POST /api/restart` reloads config and reconnects both bot and MCP client.

### Permission Flow

Permissions arrive as plain `POST /api/permission` requests (not MCP tool calls). The flow:
1. External system (e.g., `claude-code-container`) sends permission request with `queryId`, `chatId`, `toolName`, `toolInput`
2. If `chatId` is present → Telegram inline keyboard (Allow/Deny/Always Allow); if empty → Web SSE stream
3. User decision resolves the pending HTTP response as `{ queryId, decision, timedOut }`
4. "Always Allow" persists in-memory per tool name; `/revoke` command clears the allowlist

### Ask Flow (human-in-the-loop questions)

The `ask` tool sends a ForceReply question to Telegram and returns a `questionId` immediately (optionally waiting up to 240s via `waitSeconds`). In `bot.ts`, `handleTextMessage()` checks `tryResolveFromMessage()` **before** forwarding to the target MCP: a reply targeting the question message (or, for plain messages, the oldest pending question in the chat) is consumed as the answer and acknowledged with a 👍 reaction instead of being forwarded. Clients poll `get_answer` (long-poll capped at 240s per call, so no client timeout tuning is needed) until `answered`/`expired`. Questions expire after `timeoutSeconds` (default/max 24h); answered/expired records are purged ~1h after expiry; state is in-memory and does not survive restarts.

### Important Implementation Details

- The text message handler in `bot.ts` is intentionally not awaited — it fires and forgets to prevent grammY's sequential update processing from deadlocking when a permission callback query arrives while the text handler is blocked waiting for MCP.
- `MCPServer.createRouter()` must be mounted before Express `json()` middleware because MCP transports handle their own body parsing.
- The `wrapTransport()` function in `mcp-client.ts` silently swallows errors from `notifications/initialized` to handle servers that don't support that notification.
- Environment variables: `PUBLIC_URL` for external URL resolution, `PORT` for server port override.

### Template Variables

Available in `target.params` mappings: `{{text}}`, `{{chatId}}`, `{{userId}}`, `{{username}}`, `{{firstName}}`, `{{lastName}}`, `{{messageId}}`, `{{date}}`, `{{isBot}}`, `{{languageCode}}`, `{{permissionCallbackUrl}}`
