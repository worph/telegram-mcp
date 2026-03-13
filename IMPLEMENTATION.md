# Implementation Notes

Technical documentation for building the Telegram MCP bridge.

## Architecture Decisions

### Why This Architecture?

MCP is inherently **request-response** (client calls server tools), but Telegram messages arrive **asynchronously**. We solved this with a hybrid approach:

1. **Telegram MCP Server** - Exposes tools (`send_message`, `send_photo`) that LLMs can call
2. **MCP Client** - Calls the configured LLM MCP when a Telegram message arrives
3. **grammY Bot** - Handles Telegram communication (webhook or polling)

This creates a bidirectional flow:
- Incoming: Telegram → Bot → MCP Client → LLM MCP
- Outgoing: LLM MCP → calls `send_message` tool → Bot → Telegram

### Alternative Architectures Considered

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| Polling-based (Claude polls for messages) | Pure MCP | Requires active polling loop | Rejected |
| Message queue (Redis/SQLite) | Decoupled | Extra infrastructure | Overkill |
| SSE/Streaming MCP | True bidirectional | Requires specific client support | Future option |
| **External orchestrator** | Clean, real-time | More components | **Chosen** |

### Single User, Single Conversation

The system is intentionally simple:
- One Telegram bot instance
- One MCP target configuration
- No multi-tenancy, no user management
- Auth handled externally via reverse proxy

---

## Technology Choices

### Telegram Library: grammY

**Why grammY over alternatives:**

| Library | Assessment |
|---------|------------|
| **grammY** ✓ | TypeScript-first, modern API, great docs, built-in webhook support |
| Telegraf | Mature but older patterns, less TS-native |
| node-telegram-bot-api | Lower-level, more boilerplate |

**Key grammY features we'll use:**
- `bot.on("message:text", handler)` - Message handling
- `bot.api.sendMessage()` - Sending messages
- Built-in webhook adapter for Express
- Long polling for development

### MCP SDK: @modelcontextprotocol/sdk

Official SDK provides:
- `McpServer` class for exposing tools
- `McpClient` class for calling other MCP servers
- Support for stdio, HTTP, and SSE transports

### Web UI: Plain HTML + Vanilla JS

**Why no framework:**
- Simple config form, not a complex app
- Zero build step
- Easy to modify
- Served directly by Express

**Styling:** Tailwind CSS via CDN for quick, decent-looking UI without build tooling.

### Backend: Express

Minimal REST API for the config UI:
- `GET /api/config` - Retrieve current config
- `POST /api/config` - Update config
- `POST /api/restart` - Restart bot with new config
- `GET /api/status` - Bot status

---

## Configuration Schema

```typescript
interface Config {
  telegram: {
    botToken: string;
    mode: "polling" | "webhook";
    webhookUrl?: string;  // Required if mode is "webhook"
  };

  target: {
    // MCP connection
    transport: "stdio" | "http" | "sse";
    command?: string;     // For stdio: e.g., "npx @myorg/llm-mcp"
    url?: string;         // For http/sse: e.g., "http://localhost:3001/mcp"

    // Tool invocation
    tool: string;         // Tool name to call, e.g., "chat"

    // Parameter template (supports {{variable}} placeholders)
    params: Record<string, any>;
  };

  server?: {
    port: number;         // Default: 8080
  };
}
```

### Template Variables

When a Telegram message arrives, these variables are available for parameter mapping:

| Variable | Type | Description |
|----------|------|-------------|
| `{{text}}` | string | Message text content |
| `{{chatId}}` | string | Telegram chat ID |
| `{{messageId}}` | number | Telegram message ID |
| `{{username}}` | string | Sender's username (may be empty) |
| `{{firstName}}` | string | Sender's first name |
| `{{lastName}}` | string | Sender's last name (may be empty) |
| `{{timestamp}}` | number | Unix timestamp |

**Example config:**
```json
{
  "telegram": {
    "botToken": "123456:ABC-DEF...",
    "mode": "polling"
  },
  "target": {
    "transport": "stdio",
    "command": "npx @myorg/llm-mcp",
    "tool": "chat",
    "params": {
      "message": "{{text}}",
      "chatId": "{{chatId}}",
      "user": "{{firstName}}"
    }
  }
}
```

---

## MCP Server Implementation

### Tools to Expose

#### `send_message`

```typescript
{
  name: "send_message",
  description: "Send a text message to a Telegram chat",
  inputSchema: {
    type: "object",
    properties: {
      chatId: {
        type: "string",
        description: "Telegram chat ID"
      },
      text: {
        type: "string",
        description: "Message text (supports Markdown)"
      },
      parseMode: {
        type: "string",
        enum: ["Markdown", "HTML"],
        default: "Markdown"
      }
    },
    required: ["chatId", "text"]
  }
}
```

#### `send_photo`

```typescript
{
  name: "send_photo",
  description: "Send a photo to a Telegram chat",
  inputSchema: {
    type: "object",
    properties: {
      chatId: { type: "string" },
      url: { type: "string", description: "Image URL" },
      caption: { type: "string" }
    },
    required: ["chatId", "url"]
  }
}
```

### Future Tools (Not in MVP)

- `send_document` - Send files
- `send_location` - Send GPS coordinates
- `edit_message` - Edit a previously sent message
- `delete_message` - Delete a message
- `get_chat_info` - Get chat metadata

---

## Message Flow

### Incoming Message (Telegram → LLM)

```
1. User sends message on Telegram
2. grammY bot receives via polling/webhook
3. Extract message data:
   - text, chatId, username, firstName, etc.
4. Apply parameter template from config
5. Call MCP target:
   client.callTool(config.target.tool, resolvedParams)
6. LLM processes and responds by calling send_message tool
```

### Outgoing Message (LLM → Telegram)

```
1. LLM calls send_message tool with {chatId, text}
2. MCP server receives tool call
3. Validate parameters
4. Call bot.api.sendMessage(chatId, text)
5. Return success/error to LLM
```

---

## Web UI Specification

### Layout

Single page with sections:
1. **Status bar** - Connection status, last message time
2. **Telegram config** - Bot token, mode selection
3. **MCP target config** - Transport, command/URL, tool name
4. **Parameter mapping** - JSON editor or form fields
5. **Actions** - Test connection, Save & Restart

### API Endpoints

```
GET  /api/config          → Current config (token masked)
POST /api/config          → Update config, validate, save
POST /api/restart         → Restart bot with current config
GET  /api/status          → { running: bool, lastMessage: timestamp }
POST /api/test-telegram   → Send test message
POST /api/test-mcp        → Test MCP connection
```

### Config Validation

Before saving:
- Bot token format: `^\d+:[A-Za-z0-9_-]+$`
- Webhook URL must be HTTPS (if webhook mode)
- MCP command/URL required based on transport
- Tool name required
- Params must be valid JSON

---

## File Structure

```
telegram-mcp/
├── src/
│   ├── index.ts           # Entry point, wires everything
│   ├── bot.ts             # grammY bot setup and handlers
│   ├── mcp-server.ts      # MCP server with Telegram tools
│   ├── mcp-client.ts      # MCP client to call target LLM
│   ├── config.ts          # Load, save, validate config
│   ├── api.ts             # Express routes for Web UI
│   ├── template.ts        # Parameter template resolution
│   └── types.ts           # TypeScript interfaces
├── web/
│   ├── index.html         # Config UI page
│   └── app.js             # UI logic (vanilla JS)
├── config.json            # Runtime config (gitignored)
├── config.example.json    # Example config (committed)
├── package.json
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml
├── README.md
└── IMPLEMENTATION.md
```

---

## Dependencies

```json
{
  "dependencies": {
    "grammy": "^1.x",
    "@modelcontextprotocol/sdk": "^1.x",
    "express": "^4.x",
    "zod": "^3.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "@types/node": "^20.x",
    "@types/express": "^4.x",
    "tsx": "^4.x"
  }
}
```

---

## Docker

### Dockerfile

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY dist/ ./dist/
COPY web/ ./web/

EXPOSE 8080

CMD ["node", "dist/index.js"]
```

### docker-compose.yml

```yaml
version: "3.8"

services:
  telegram-mcp:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - ./config.json:/app/config.json
    environment:
      - LOG_LEVEL=info
    restart: unless-stopped
```

---

## Error Handling

### Telegram Errors

- **Token invalid** → Log error, set status to "disconnected"
- **Rate limited** → Respect retry-after, queue messages
- **Chat not found** → Return error to LLM tool call

### MCP Target Errors

- **Connection failed** → Retry with backoff, notify via status API
- **Tool not found** → Return error, log config issue
- **Tool execution error** → Pass error back, don't crash

### Recovery

- Bot auto-reconnects on network issues (grammY handles this)
- MCP client reconnects on each message (stateless)
- Config errors shown in Web UI status

---

## Security Considerations

1. **Bot token** - Stored in config.json, masked in API responses
2. **Web UI auth** - Handled externally via reverse proxy
3. **Input validation** - Sanitize all user inputs before MCP calls
4. **No secrets in logs** - Mask sensitive data

---

## Testing Strategy

### Manual Testing

1. Start with polling mode (no public URL needed)
2. Send messages to bot via Telegram
3. Verify MCP target receives calls
4. Verify responses come back to Telegram

### Integration Test Checklist

- [ ] Bot connects with valid token
- [ ] Bot rejects invalid token
- [ ] Incoming message triggers MCP call
- [ ] Template variables resolve correctly
- [ ] send_message tool works
- [ ] Config UI loads
- [ ] Config saves and restarts bot
- [ ] Status API reflects actual state

---

## Future Enhancements

1. **Message history** - Keep last N messages, send as context
2. **Multiple tools** - Route different commands to different MCP tools
3. **Media handling** - Support receiving images, documents
4. **Inline keyboards** - Interactive buttons in messages
5. **Webhook mode** - Production setup with HTTPS
6. **Health checks** - Kubernetes-friendly endpoints
