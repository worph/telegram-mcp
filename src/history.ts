import * as fs from "fs";
import * as path from "path";

/**
 * Per-chat message history store. Telegram's Bot API cannot fetch chat history,
 * so we keep our own rolling transcript of messages the bot has seen (both
 * incoming user messages and outgoing bot replies) and expose it via the
 * `get_chat_history` MCP tool so an LLM can pull conversation context on demand.
 *
 * Persisted to disk (JSON) so it survives container restarts. Writes are
 * debounced to avoid hammering the disk on busy chats.
 */

export interface StoredMessage {
  role: "user" | "assistant";
  name?: string; // username / first name for users; omitted for the bot
  text: string;
  date: number; // unix seconds
}

const HISTORY_PATH =
  process.env.HISTORY_PATH || path.join(process.cwd(), "data", "history.json");
const MAX_PER_CHAT = parseInt(process.env.HISTORY_MAX || "50", 10);
const SAVE_DEBOUNCE_MS = 2000;

const store = new Map<string, StoredMessage[]>();
let saveTimer: NodeJS.Timeout | null = null;

export function loadHistory(): void {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return;
    const raw = fs.readFileSync(HISTORY_PATH, "utf-8");
    const data = JSON.parse(raw) as Record<string, StoredMessage[]>;
    store.clear();
    for (const [chatId, msgs] of Object.entries(data)) {
      if (Array.isArray(msgs)) store.set(chatId, msgs.slice(-MAX_PER_CHAT));
    }
    console.log(`Loaded chat history for ${store.size} chat(s) from ${HISTORY_PATH}`);
  } catch (err) {
    console.warn("Failed to load chat history:", err instanceof Error ? err.message : err);
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const dir = path.dirname(HISTORY_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj: Record<string, StoredMessage[]> = {};
      for (const [chatId, msgs] of store.entries()) obj[chatId] = msgs;
      fs.writeFileSync(HISTORY_PATH, JSON.stringify(obj), "utf-8");
    } catch (err) {
      console.warn("Failed to persist chat history:", err instanceof Error ? err.message : err);
    }
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

export function recordMessage(chatId: string, msg: StoredMessage): void {
  if (!chatId || !msg.text) return;
  const list = store.get(chatId) ?? [];
  list.push(msg);
  if (list.length > MAX_PER_CHAT) list.splice(0, list.length - MAX_PER_CHAT);
  store.set(chatId, list);
  scheduleSave();
}

export function getHistory(chatId: string, limit?: number): StoredMessage[] {
  const list = store.get(chatId) ?? [];
  if (limit && limit > 0 && limit < list.length) return list.slice(-limit);
  return [...list];
}
