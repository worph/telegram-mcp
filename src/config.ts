import * as fs from "fs";
import * as path from "path";
import { Config, ConfigSchema } from "./types.js";

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(process.cwd(), "config.json");

export const PLACEHOLDER_TOKEN = "000000000:XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

export function isPlaceholderConfig(config: Config): boolean {
  return config.telegram.botToken === PLACEHOLDER_TOKEN;
}

const DEFAULT_CONFIG: Config = {
  telegram: {
    botToken: "000000000:XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    mode: "polling",
  },
  target: {
    transport: "http",
    url: "http://localhost:9634/mcp",
    tool: "echo",
    params: {
      message: "{{text}}",
      chatId: "{{chatId}}",
      username: "{{username}}",
    },
  },
  server: {
    port: 9634,
  },
};

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(`Config file not found at ${CONFIG_PATH}, creating default config...`);
    const configDir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    console.log(`Default config created at ${CONFIG_PATH}. Configure via Web UI or edit the file directly.`);
    return DEFAULT_CONFIG;
  }

  const rawContent = fs.readFileSync(CONFIG_PATH, "utf-8");
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawContent);
  } catch (e: unknown) {
    throw new Error(`Invalid JSON in config file: ${e}`);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.errors.map(
      (e: { path: (string | number)[]; message: string }) => `  - ${e.path.join(".")}: ${e.message}`
    ).join("\n");
    throw new Error(`Invalid config:\n${errors}`);
  }

  return result.data;
}

export function saveConfig(config: Config): void {
  const result = ConfigSchema.safeParse(config);
  if (!result.success) {
    const errors = result.error.errors.map(
      (e: { path: (string | number)[]; message: string }) => `  - ${e.path.join(".")}: ${e.message}`
    ).join("\n");
    throw new Error(`Invalid config:\n${errors}`);
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(result.data, null, 2), "utf-8");
}

export function validateConfig(config: unknown): { valid: boolean; errors?: string[] } {
  const result = ConfigSchema.safeParse(config);
  if (result.success) {
    return { valid: true };
  }

  const errors = result.error.errors.map(
    (e: { path: (string | number)[]; message: string }) => `${e.path.join(".")}: ${e.message}`
  );
  return { valid: false, errors };
}

export function maskToken(token: string): string {
  if (token.length < 10) return "***";
  const parts = token.split(":");
  if (parts.length === 2) {
    return `${parts[0]}:${"*".repeat(Math.min(parts[1].length, 10))}`;
  }
  return `${token.substring(0, 5)}${"*".repeat(10)}`;
}

export function getMaskedConfig(config: Config): Config {
  return {
    ...config,
    telegram: {
      ...config.telegram,
      botToken: maskToken(config.telegram.botToken),
    },
  };
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
