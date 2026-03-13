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
                    │  │  Web UI   │ :8080                   │
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

The Web UI will be available at `http://localhost:8088`

### Running without Docker

```bash
# Install dependencies
npm install

# Build
npm run build

# Copy and edit config
cp config.example.json config.json

# Start the server
npm start
```

## Configuration

Access the Web UI at `http://localhost:8088` (Docker) or `http://localhost:8080` (local) to configure:

### Telegram Settings

| Field | Description |
|-------|-------------|
| Bot Token | Token from BotFather |
| Mode | `polling` (simple) or `webhook` (production) |
| Webhook URL | Public URL for webhook mode |

### MCP Target Settings

| Field | Description |
|-------|-------------|
| Transport | `stdio`, `http`, or `sse` |
| Command | For stdio: the command to spawn the MCP server |
| URL | For http/sse: the MCP server endpoint |
| Tool Name | The tool to call on incoming messages (e.g., `chat`) |

### Parameter Mapping

Configure how Telegram message data maps to MCP tool parameters:

| Template Variable | Value |
|-------------------|-------|
| `{{text}}` | Message text content |
| `{{chatId}}` | Telegram chat ID |
| `{{username}}` | Sender's username |
| `{{firstName}}` | Sender's first name |

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
  chatId: string;   // Target chat ID
  text: string;     // Message content (supports Markdown)
}
```

### `send_photo`

Send a photo to a Telegram chat.

```typescript
{
  chatId: string;   // Target chat ID
  url: string;      // Image URL
  caption?: string; // Optional caption
}
```

## Project Structure

```
telegram-mcp/
├── src/
│   ├── mcp-server.ts      # MCP server exposing Telegram tools
│   ├── mcp-client.ts      # MCP client for calling target LLM
│   ├── bot.ts             # grammY Telegram bot
│   ├── config.ts          # Configuration management
│   ├── api.ts             # REST API for Web UI
│   └── index.ts           # Application entry point
├── web/
│   ├── index.html         # Configuration UI
│   └── app.js             # UI logic
├── config.json            # Runtime configuration
├── Dockerfile
├── docker-compose.yml
└── package.json
```

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
| `PORT` | Web UI / API port | `8080` |
| `CONFIG_PATH` | Path to config file | `./config.json` |
| `LOG_LEVEL` | Logging verbosity | `info` |

## License

MIT
