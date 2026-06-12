import * as os from "os";

export function getMcpInfo(): string {
  const publicUrl = process.env.PUBLIC_URL;
  const hostname = os.hostname();
  const port = process.env.PORT || "9634";
  const localUrl = `http://${hostname}:${port}`;

  const endpointLines = [];
  if (publicUrl) {
    endpointLines.push(`• Public: \`${publicUrl}/mcp\``);
  }
  endpointLines.push(`• Docker (local network): \`${localUrl}/mcp\``);

  const configUrl = publicUrl ? `${publicUrl}/mcp` : `${localUrl}/mcp`;

  return `
🔌 *Telegram MCP Server — Connection Info*

*Status:* Connected and ready to use
*Server:* telegram-mcp v1.0.0

━━━━━━━━━━━━━━━━━━━━━━

🛠️ *Your Available Tools*

These tools are already connected to your MCP client. Just call them directly — no additional setup needed.

1. \`send_message\` — Send a text message to Telegram
   • \`text\` (required): Message content
   • \`parseMode\`: "Markdown" or "HTML"
   • \`chatId\` (optional): Defaults to the last active chat

2. \`send_photo\` — Send a photo to Telegram
   • \`url\` (required): Photo URL
   • \`caption\`: Optional caption
   • \`chatId\` (optional): Defaults to the last active chat

3. \`ask\` — Ask the user a question and collect their reply
   • \`question\` (required): The question text
   • \`waitSeconds\`: Wait up to 240s for a quick answer in the same call
   • Returns a \`questionId\` — poll \`get_answer\` until answered (questions stay open up to 24h)

4. \`get_answer\` — Fetch / long-poll the answer to a question
   • \`questionId\`: From \`ask\` (defaults to the most recent question)
   • \`waitSeconds\`: Long-poll up to 240s per call

5. \`get_chat_history\` — Retrieve recent messages the bot has seen
   • \`limit\`: Max messages to return (default 20)

6. \`mcp_info\` — Show this info again

_You do not need to specify chatId — the bot automatically routes messages to the correct chat._

━━━━━━━━━━━━━━━━━━━━━━

📋 *Setup Reference (for adding to new MCP clients)*

*Endpoints:*
${endpointLines.join("\n")}

_Use the Docker URL if your MCP client runs on the same Docker network. Use the Public URL for external access._

*Client config example:*
\`\`\`json
{
  "mcpServers": {
    "telegram": {
      "type": "http",
      "url": "${configUrl}"
    }
  }
}
\`\`\`
`.trim();
}
