import * as os from "os";

export function getMcpInfo(): string {
  const baseUrl = process.env.BASE_URL || "http://localhost:9634";
  const hostname = os.hostname();
  const port = process.env.PORT || "9634";

  return `
🔌 *MCP Server Installation Info*

*Server Name:* telegram-mcp
*Version:* 1.0.0

━━━━━━━━━━━━━━━━━━━━━━

📡 *Connection Endpoints*

*HTTP/SSE (recommended):*
\`${baseUrl}/mcp/sse\`

*Docker Network:*
\`http://${hostname}:${port}/mcp/sse\`

━━━━━━━━━━━━━━━━━━━━━━

⚙️ *Supported Transports*
• SSE (Server-Sent Events) ✅
• HTTP ✅

━━━━━━━━━━━━━━━━━━━━━━

🛠️ *Available Tools*

1. \`send_message\` - Send text message
   • text (required): Message content
   • parseMode: "Markdown" or "HTML"
   • chatId (optional): Falls back to last active chat

2. \`send_photo\` - Send photo
   • url (required): Photo URL
   • caption: Optional caption
   • chatId (optional): Falls back to last active chat

3. \`mcp_info\` - Show this info
   • chatId (optional): Falls back to last active chat

_No chatId needed — the bot routes to the right chat automatically._

━━━━━━━━━━━━━━━━━━━━━━

📋 *Example MCP Client Config*

\`\`\`json
{
  "mcpServers": {
    "telegram": {
      "transport": "sse",
      "url": "${baseUrl}/mcp/sse"
    }
  }
}
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━

🐳 *Docker Compose*

\`\`\`yaml
services:
  telegram-mcp:
    image: telegram-mcp
    ports:
      - "9634:9634"
    environment:
      - BASE_URL=http://your-domain.com:9634
\`\`\`
`.trim();
}
