import { createApi } from "./api";
import { TelegramBot } from "./bot";
import { loadConfig } from "./config";
import { MCPClient } from "./mcp-client";
import { MCPServer } from "./mcp-server";
import { PermissionService, WebPermissionService } from "./permission-service";

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
    console.log(`MCP Server available at http://localhost:${port}/mcp/sse`);
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
