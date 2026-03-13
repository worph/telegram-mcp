import express, { Request, Response, Router } from "express";
import * as path from "path";
import { TelegramBot } from "./bot";
import { getMaskedConfig, loadConfig, saveConfig, validateConfig } from "./config";
import { MCPClient } from "./mcp-client";
import { MCPServer } from "./mcp-server";
import { Config } from "./types";

export interface ApiDependencies {
  bot: TelegramBot;
  mcpClient: MCPClient;
  mcpServer: MCPServer;
  onRestart: () => Promise<void>;
}

export function createApi(deps: ApiDependencies): express.Application {
  const app = express();

  // Mount MCP server routes BEFORE json middleware (MCP needs raw body)
  app.use("/mcp", deps.mcpServer.createRouter());

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "../web")));

  const apiRouter = createApiRouter(deps);
  app.use("/api", apiRouter);

  app.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "../web/index.html"));
  });

  return app;
}

function createApiRouter(deps: ApiDependencies): Router {
  const router = Router();

  router.get("/config", (_req: Request, res: Response) => {
    try {
      const config = loadConfig();
      const masked = getMaskedConfig(config);
      res.json(masked);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to load config",
      });
    }
  });

  router.post("/config", (req: Request, res: Response) => {
    try {
      const newConfig = req.body as Config;

      const currentConfig = loadConfig();
      if (newConfig.telegram.botToken.includes("*")) {
        newConfig.telegram.botToken = currentConfig.telegram.botToken;
      }

      const validation = validateConfig(newConfig);
      if (!validation.valid) {
        res.status(400).json({ error: "Invalid config", details: validation.errors });
        return;
      }

      saveConfig(newConfig);

      deps.bot.updateConfig(newConfig);
      deps.mcpClient.updateConfig(newConfig.target);

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to save config",
      });
    }
  });

  router.post("/restart", async (_req: Request, res: Response) => {
    try {
      await deps.onRestart();
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to restart",
      });
    }
  });

  router.get("/status", (_req: Request, res: Response) => {
    const botStatus = deps.bot.getStatus();
    const mcpConnected = deps.mcpClient.isConnected();

    res.json({
      bot: botStatus,
      mcpClient: {
        connected: mcpConnected,
      },
    });
  });

  return router;
}
