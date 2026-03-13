# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Run Commands

```bash
# Install dependencies (uses pnpm)
pnpm install

# Build TypeScript to dist/
pnpm run build

# Start the server
pnpm start

# Watch mode for development
pnpm run dev

# Clean build output
pnpm run clean
```

For Docker deployment:
```bash
docker compose up -d          # Start
docker compose up --build -d  # Rebuild and restart
docker compose down           # Stop
```

## Architecture

This is a bidirectional Telegram bot that integrates with the Model Context Protocol (MCP). It acts as both an MCP server (exposing Telegram tools to LLMs) and an MCP client (forwarding Telegram messages to a target MCP server).

### Core Components

- **`src/index.ts`** - Entry point that wires together all components and handles graceful shutdown
- **`src/bot.ts`** - grammY-based Telegram bot that handles incoming messages and exposes `sendMessage`/`sendPhoto` methods
- **`src/mcp-server.ts`** - MCP server exposing Telegram tools (`send_message`, `send_photo`, `echo`, `mcp_info`) via SSE/HTTP transport at `/mcp`
- **`src/mcp-client.ts`** - MCP client that connects to a target MCP server to forward incoming messages
- **`src/api.ts`** - Express REST API for the Web UI configuration interface
- **`src/config.ts`** - Configuration loading/saving with Zod validation from `config.json`
- **`src/template.ts`** - Template resolution for mapping Telegram message data to MCP tool parameters using `{{variable}}` syntax
- **`src/types.ts`** - Zod schemas and TypeScript types for configuration and messages

### Data Flow

1. User sends Telegram message -> `TelegramBot` receives via grammY polling
2. `TelegramBot.handleTextMessage()` creates `MessageContext` and resolves parameter templates
3. `MCPClient.callTool()` forwards the resolved parameters to the target MCP server
4. Target LLM processes and calls `send_message` tool on this server's MCP endpoint
5. `MCPServer` handles the tool call and uses `TelegramBot.sendMessage()` to reply

### Configuration

Configuration is managed via `config.json` with three sections:
- `telegram`: Bot token and mode (polling/webhook)
- `target`: MCP client settings (transport, url, tool name, parameter mappings)
- `server`: Web UI port

The Web UI at `http://localhost:8080` allows runtime configuration. The `/api/restart` endpoint reloads config and reconnects both bot and MCP client.

### Permission Flow

Permission prompts are handled via a REST endpoint (`POST /api/permission`) rather than MCP tools. The flow:

1. `claude-code-container`'s `server.js` spawns Claude CLI with `permission-mcp.js` as a stdio MCP server
2. Claude CLI calls `permission_prompt` tool on `permission-mcp.js` when it needs approval
3. `permission-mcp.js` sends a plain `POST` to `permissionCallbackUrl` (e.g., `http://telegram-mcp:8080/api/permission`)
4. `api.ts` receives the request and delegates to `PermissionService.requestPermission()`
5. Telegram user sees inline keyboard (Allow/Deny/Always Allow), clicks a button
6. Response `{ queryId, decision, timedOut }` is returned as plain JSON — no SSE, no JSON-RPC unwrapping

The callback URL is passed per-request via `params.permissionCallbackUrl` in the target config, so no static env var is needed on the claude-code container.

### Template Variables

Available in parameter mappings: `{{text}}`, `{{chatId}}`, `{{userId}}`, `{{username}}`, `{{firstName}}`, `{{lastName}}`, `{{messageId}}`, `{{date}}`, `{{isBot}}`, `{{languageCode}}`
