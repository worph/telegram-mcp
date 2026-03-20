import { createApi } from "./api.js";
import { TelegramBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { MCPClient } from "./mcp-client.js";
import { MCPServer } from "./mcp-server.js";
import { PermissionService, WebPermissionService } from "./permission-service.js";

import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const { createDiscoveryResponder } = _require("../mcp-announce.cjs");

async function main(): Promise<void> {
  console.log("Starting Telegram MCP...");

  let config = loadConfig();
  console.log("Config loaded");

  const bot = new TelegramBot(config);
  const mcpClient = new MCPClient(config.target);
  const mcpServer = new MCPServer(bot);
  const permissionService = new PermissionService();
  const webPermissionService = new WebPermissionService();

  // Wire up dependencies
  bot.setMCPClient(mcpClient);
  bot.setPermissionService(permissionService);
  permissionService.setBot(bot);

  const restart = async (): Promise<void> => {
    console.log("Restarting...");
    await bot.stop();
    await mcpClient.disconnect();

    config = loadConfig();
    bot.updateConfig(config);
    mcpClient.updateConfig(config.target);

    let botError: unknown = null;
    try {
      await bot.start();
    } catch (err) {
      botError = err;
    }
    try {
      await mcpClient.connect();
    } catch (err) {
      console.warn("MCP client connection failed (will retry on message):", err);
    }
    console.log("Restart complete");
    if (botError) throw botError;
  };

  const app = createApi({
    bot,
    mcpClient,
    mcpServer,
    permissionService,
    webPermissionService,
    onRestart: restart,
  });

  const port = config.server?.port || 9634;
  const server = app.listen(port, () => {
    console.log(`Web UI available at http://localhost:${port}`);
    console.log(`MCP Server available at http://localhost:${port}/mcp`);

    // Beacon discovery
    createDiscoveryResponder({
      name: "telegram-mcp",
      description: "Telegram bot bridge — send messages and photos via Telegram",
      tools: [
        { name: "send_message", description: "Send a text message to a Telegram chat", inputSchema: { type: "object", properties: { chatId: { type: "string" }, text: { type: "string" }, parseMode: { type: "string", enum: ["Markdown", "HTML"] } }, required: ["text"] } },
        { name: "send_photo", description: "Send a photo to a Telegram chat", inputSchema: { type: "object", properties: { chatId: { type: "string" }, url: { type: "string" }, caption: { type: "string" } }, required: ["url"] } },
        { name: "echo", description: "Echo a message back — useful for testing the MCP connection", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
        { name: "mcp_info", description: "Send MCP server installation and connection information to a Telegram chat", inputSchema: { type: "object", properties: { chatId: { type: "string" } } } },
      ],
      port,
      listenPort: parseInt(process.env.DISCOVERY_PORT || "9099"),
    });
  });

  // Start bot (don't crash if token is invalid - user can fix via UI)
  try {
    await bot.start();
  } catch (err) {
    console.warn("Bot failed to start (configure via Web UI):", err instanceof Error ? err.message : err);
  }

  try {
    await mcpClient.connect();
  } catch (err) {
    console.warn("MCP client connection failed (will retry on message):", err);
  }

  console.log("Telegram MCP is running. Configure via Web UI if needed.");

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nReceived ${signal}, shutting down...`);

    server.close();
    await bot.stop();
    await mcpClient.disconnect();
    await mcpServer.stop();

    console.log("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
