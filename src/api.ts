import express, { Request, Response, Router } from "express";
import * as os from "os";
import * as path from "path";
import { TelegramBot } from "./bot";
import { getMaskedConfig, loadConfig, saveConfig, validateConfig } from "./config";
import { MCPClient } from "./mcp-client";
import { MCPServer } from "./mcp-server";
import { PermissionService, WebPermissionService } from "./permission-service";
import { Config, HandlePermissionParams, WebPermissionResolveBody } from "./types";

export interface ApiDependencies {
  bot: TelegramBot;
  mcpClient: MCPClient;
  mcpServer: MCPServer;
  permissionService: PermissionService;
  webPermissionService: WebPermissionService;
  onRestart: () => Promise<void>;
}

export function createApi(deps: ApiDependencies): express.Application {
  const app = express();

  // Mount MCP server routes BEFORE json middleware (MCP needs raw body)
  app.use("/mcp", deps.mcpServer.createRouter());

  // Mount webhook route with its own JSON parser (before the global one, after MCP)
  app.post("/webhook", express.json(), (req, res, next) => {
    const handler = deps.bot.getWebhookMiddleware();
    if (handler) {
      handler(req, res, next);
    } else {
      res.status(404).json({ error: "Webhook not active" });
    }
  });

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
      bot: {
        ...botStatus,
        defaultChatId: deps.bot.getDefaultChatId(),
      },
      mcpClient: {
        connected: mcpConnected,
      },
    });
  });

  router.get("/public-url", (_req: Request, res: Response) => {
    const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, "") || "";
    res.json({ publicUrl, webhookUrl: publicUrl ? `${publicUrl}/webhook` : "" });
  });

  router.post("/send-mcp-info", async (req: Request, res: Response) => {
    if (!deps.mcpClient.isConnected()) {
      res.status(400).json({ error: "MCP target is not connected" });
      return;
    }

    const baseUrl = (process.env.PUBLIC_URL || `http://${os.hostname()}:${process.env.PORT || 9634}`).replace(/\/$/, "");
    const claudeConfig = JSON.stringify({ mcpServers: { telegram: { type: "sse", url: `${baseUrl}/mcp/sse` } } }, null, 2);
    const infoText = [
      "A Telegram MCP server is available for you to connect to. Please acknowledge that you have received these connection details and confirm you are ready to use the `send_message` tool to send messages to the user via Telegram.",
      "",
      "Connection details:",
      `- SSE endpoint: ${baseUrl}/mcp/sse`,
      `- HTTP endpoint: ${baseUrl}/mcp`,
      "",
      "Available tools on this MCP server:",
      "- send_message(text, parseMode?, chatId?) — sends a text message to a Telegram chat. chatId is optional; if omitted the bot automatically routes to the last active chat or configured default.",
      "- send_photo(url, caption?, chatId?) — sends a photo to a Telegram chat. chatId is optional; if omitted the bot automatically routes to the last active chat or configured default.",
      "",
      "IMPORTANT: You do NOT need a chat ID to send messages. Simply call send_message with just the text parameter and the bot will deliver it to the right chat.",
      "",
      "To add this server to Claude Desktop, add the following to claude_desktop_config.json:",
      "```json",
      claudeConfig,
      "```",
      "",
      "Please confirm receipt by calling send_message with a short test greeting. No chatId is needed — the bot handles routing automatically.",
    ].join("\n");

    try {
      const result = await deps.mcpClient.sendText(infoText, `${baseUrl}/api/permission`);
      const content = (result as any)?.content;
      const responseText = Array.isArray(content)
        ? content
            .filter((c: any) => c.type === "text" && c.text)
            .map((c: any) => c.text)
            .filter((t: string) => !t.startsWith("[stderr]"))
            .join("\n")
            .trim()
        : "";
      res.json({ success: true, response: responseText });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to send" });
    }
  });

  router.get("/mcp-server-info", (req: Request, res: Response) => {
    const baseUrl = (process.env.PUBLIC_URL || `http://${os.hostname()}:${process.env.PORT || 9634}`).replace(/\/$/, "");
    res.json({
      sseUrl: `${baseUrl}/mcp/sse`,
      httpUrl: `${baseUrl}/mcp`,
      tools: [
        { name: "send_message", description: "Send a text message to a Telegram chat (chatId optional)", params: ["text", "parseMode?", "chatId?"] },
        { name: "send_photo", description: "Send a photo to a Telegram chat (chatId optional)", params: ["url", "caption?", "chatId?"] },
      ],
      claudeConfig: {
        mcpServers: {
          telegram: {
            type: "sse",
            url: `${baseUrl}/mcp/sse`,
          },
        },
      },
    });
  });

  router.post("/permission", async (req: Request, res: Response) => {
    try {
      const params = req.body as HandlePermissionParams;
      console.log(`[permission] Incoming request: queryId=${params.queryId} tool=${params.toolName} chatId=${params.chatId || "(empty/web)"} input=${JSON.stringify(params.toolInput)}`);
      if (!params.queryId || !params.toolName || !params.toolInput) {
        console.log(`[permission] Rejected: missing required parameters (queryId=${params.queryId}, toolName=${params.toolName}, toolInput=${!!params.toolInput})`);
        res.status(400).json({ error: "Missing required parameters: queryId, toolName, toolInput" });
        return;
      }

      // Route by chatId: empty/absent/web-prefixed → web SSE, otherwise → Telegram
      const isWebChat = !params.chatId || params.chatId === "" || params.chatId.startsWith("web-");
      if (isWebChat) {
        console.log(`[permission] Routing to Web UI (SSE) — tool=${params.toolName} queryId=${params.queryId} chatId=${params.chatId || "(empty)"}`);
        const response = await deps.webPermissionService.requestPermission({
          queryId: params.queryId,
          toolName: params.toolName,
          toolInput: params.toolInput,
          description: params.description,
          timeout: params.timeout,
        });
        console.log(`[permission] Web resolved: queryId=${response.queryId} decision=${response.decision} timedOut=${response.timedOut}`);
        res.json(response);
      } else {
        console.log(`[permission] Routing to Telegram — tool=${params.toolName} chatId=${params.chatId} queryId=${params.queryId}`);
        const response = await deps.permissionService.requestPermission({
          queryId: params.queryId,
          chatId: params.chatId,
          toolName: params.toolName,
          toolInput: params.toolInput,
          description: params.description,
          timeout: params.timeout,
        });
        console.log(`[permission] Telegram resolved: queryId=${response.queryId} decision=${response.decision} timedOut=${response.timedOut}`);
        res.json(response);
      }
    } catch (error) {
      console.error(`[permission] Error processing request:`, error instanceof Error ? error.message : error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Permission request failed",
      });
    }
  });

  router.get("/permission/stream", (req: Request, res: Response) => {
    console.log("[permission] Web SSE client connected");
    deps.webPermissionService.connectClient(res);
  });

  router.post("/permission/web/resolve", (req: Request, res: Response) => {
    const body = req.body as WebPermissionResolveBody;
    if (!body.queryId || !body.decision || !body.csrfToken) {
      res.status(400).json({ error: "Missing required parameters: queryId, decision, csrfToken" });
      return;
    }

    if (!deps.webPermissionService.validateCsrfToken(body.csrfToken)) {
      res.status(403).json({ error: "Invalid CSRF token" });
      return;
    }

    const resolved = deps.webPermissionService.resolvePermission(body.queryId, body.decision);
    if (!resolved) {
      res.status(404).json({ error: "No pending permission for queryId" });
      return;
    }

    res.json({ success: true });
  });

  return router;
}
