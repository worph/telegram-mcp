# Telegram MCP

A bidirectional Telegram bot that integrates with the Model Context Protocol (MCP). Allows LLMs to send Telegram messages and receive user messages via MCP tool calls.

## Overview

```
┌────────────┐      ┌─────────────────────────────────────────┐
│  Telegram  │◄────►│            telegram-mcp container       │
│    User    │      │  ┌───────────┐  ┌───────────────────┐  │
└────────────┘      │  │  grammY   │  │    MCP Server     │  │
                    │  │   Bot     │──│  • send_message   │  │
                    │  └─────┬─────┘  │  • send_photo     │  │
                    │        │        └───────────────────┘  │
                    │        │ on message                    │
                    │        ▼                               │
                    │  ┌───────────┐      ┌──────────────┐  │
                    │  │MCP Client │─────►│  Target LLM  │  │
                    │  │(configured)│◄─────│     MCP      │  │
                    │  └───────────┘      └──────────────┘  │
                    │        ▲                               │
                    │        │ config                        │
                    │  ┌─────┴─────┐                         │
                    │  │  Web UI   │ :9634                   │
                    │  └───────────┘                         │
                    └─────────────────────────────────────────┘
```

## Features

- **Bidirectional communication**: Receive Telegram messages and send responses via MCP
- **Configurable MCP target**: Route messages to any MCP-compatible LLM server
- **Web UI**: Simple configuration interface for Telegram and MCP settings
- **Docker-ready**: Containerized deployment
- **Single-user focused**: Lightweight, no complex auth or multi-tenancy

## How It Works

1. User sends a message on Telegram
2. The bot receives the message via grammY (polling or webhook)
3. The message is forwarded to a configured MCP target (e.g., an LLM MCP server)
4. The LLM processes the message and calls `send_message` tool to respond
5. The response is sent back to the user on Telegram

## Quick Start

### Prerequisites

- Docker
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- An MCP-compatible LLM server

### Running with Docker (Recommended)

```bash
# Copy and edit config
cp config.example.json config.json

# Start with Docker Compose
docker compose up -d

# View logs
docker logs -f telegram-mcp
```

The Web UI will be available at `http://localhost:9634`

### Running without Docker

```bash
# Install dependencies
pnpm install

# Build
pnpm run build

# Copy and edit config
cp config.example.json config.json

# Start the server
pnpm start
```

## Configuration

Access the Web UI at `http://localhost:9634` to configure:

### Telegram Settings

| Field | Description |
|-------|-------------|
| Bot Token | Token from BotFather |
| Mode | `polling` (simple) or `webhook` (production) |
| Webhook URL | Public URL for webhook mode |

### MCP Target Settings

| Field | Description |
|-------|-------------|
| Transport | `http` (Streamable HTTP) |
| URL | The MCP server endpoint |
| Tool Name | The tool to call on incoming messages (e.g., `query_claude`) |
| Auth Token | Optional bearer token for authentication |

### Parameter Mapping

Configure how Telegram message data maps to MCP tool parameters:

| Template Variable | Value |
|-------------------|-------|
| `{{text}}` | Message text content |
| `{{chatId}}` | Telegram chat ID |
| `{{userId}}` | Telegram user ID |
| `{{username}}` | Sender's username |
| `{{firstName}}` | Sender's first name |
| `{{lastName}}` | Sender's last name |
| `{{messageId}}` | Telegram message ID |
| `{{date}}` | Unix timestamp |
| `{{isBot}}` | Whether sender is a bot |
| `{{languageCode}}` | Sender's language code |
| `{{permissionCallbackUrl}}` | URL for permission callbacks |

Example mapping:
```json
{
  "message": "{{text}}",
  "context": {
    "chatId": "{{chatId}}",
    "user": "{{firstName}}"
  }
}
```

## MCP Tools Exposed

This server exposes the following MCP tools for LLMs to use:

### `send_message`

Send a text message to a Telegram chat.

```typescript
{
  chatId?: string;     // Target chat ID (optional — defaults to last active chat)
  text: string;        // Message content (supports Markdown)
  parseMode?: string;  // "Markdown" or "HTML"
}
```

### `send_photo`

Send a photo to a Telegram chat.

```typescript
{
  chatId?: string;   // Target chat ID (optional — defaults to last active chat)
  url: string;       // Image URL
  caption?: string;  // Optional caption
}
```

### `echo`

Echo a message back (useful for testing).

```typescript
{
  message: string;   // Message to echo
}
```

### `mcp_info`

Send MCP server connection info to a Telegram chat.

```typescript
{
  chatId?: string;   // Target chat ID (optional)
}
```

## Project Structure

```
telegram-mcp/
├── src/
│   ├── index.ts               # Entry point, wires everything together
│   ├── bot.ts                 # grammY Telegram bot
│   ├── mcp-server.ts          # MCP server exposing Telegram tools (Streamable HTTP)
│   ├── mcp-client.ts          # MCP client for calling target LLM
│   ├── mcp-info.ts            # MCP connection info generator
│   ├── api.ts                 # Express app with REST API for Web UI
│   ├── config.ts              # Configuration management
│   ├── permission-service.ts  # Telegram & Web permission flows
│   ├── template.ts            # {{variable}} template resolution
│   └── types.ts               # Zod schemas and TypeScript interfaces
├── web/
│   ├── index.html             # Configuration UI
│   └── app.js                 # UI logic
├── config.json                # Runtime configuration (gitignored)
├── config.example.json        # Example configuration
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## Adding to Claude Code as an MCP Server

Once the Telegram MCP server is running, you can connect it to Claude Code so the LLM can use the Telegram tools directly.

### Via CLI

```bash
claude mcp add-json telegram-mcp '{"type":"url","url":"http://localhost:9634/mcp"}'
```

### Via `.mcp.json`

Create or edit `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "telegram-mcp": {
      "type": "url",
      "url": "http://localhost:9634/mcp"
    }
  }
}
```

Then restart Claude Code and approve the server when prompted (or manage it via `/mcp`).

## Development

```bash
# Rebuild and restart after code changes
docker compose up --build -d

# View logs
docker logs -f telegram-mcp

# Stop
docker compose down
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Web UI / API port | `9634` |
| `CONFIG_PATH` | Path to config file | `./config.json` |
| `PUBLIC_URL` | Public URL for external access | (none) |

## License

MIT
