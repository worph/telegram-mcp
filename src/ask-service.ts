import crypto from "crypto";

/**
 * Pending-question registry powering the `ask` / `get_answer` MCP tools
 * (human-in-the-loop questions).
 *
 * `ask` creates a question, sends it to Telegram (ForceReply) and returns
 * immediately with a questionId. The user's reply in that chat — matched by
 * the replied-to message id, or the oldest pending question as a fallback —
 * resolves it. `get_answer` long-polls (capped at MAX_WAIT_SECONDS) for the
 * answer, so no single HTTP request ever has to stay open for the full life
 * of a question (up to 24h).
 *
 * State is in-memory only: a pending question cannot survive a process
 * restart anyway, since resolving it depends on the live bot routing.
 */

export type AskStatus = "pending" | "answered" | "expired";

export interface AskQuestionRecord {
  questionId: string;
  chatId: string;
  question: string;
  status: AskStatus;
  answer?: string;
  answeredBy?: string;
  createdAt: number; // unix ms
  answeredAt?: number; // unix ms
  expiresAt: number; // unix ms
}

interface InternalQuestion extends AskQuestionRecord {
  // Telegram message id of the question, used to match ForceReply answers
  messageId?: number;
  waiters: Array<() => void>;
  timer?: NodeJS.Timeout;
}

// Questions stay open at most 24h
export const MAX_QUESTION_TIMEOUT_SECONDS = 86_400;
export const DEFAULT_QUESTION_TIMEOUT_SECONDS = 86_400;
// Long-poll cap per get_answer call — short enough to stay under default MCP
// client and reverse-proxy timeouts, long enough to make polling cheap.
export const MAX_WAIT_SECONDS = 240;

// Resolved/expired questions are kept around for late polls before deletion
const PURGE_GRACE_MS = 60 * 60 * 1000;

const questions = new Map<string, InternalQuestion>();

function toPublic(q: InternalQuestion): AskQuestionRecord {
  const { waiters: _waiters, timer: _timer, messageId: _messageId, ...pub } = q;
  return pub;
}

function notifyWaiters(q: InternalQuestion): void {
  const waiters = q.waiters;
  q.waiters = [];
  for (const w of waiters) w();
}

function scheduleDeletion(q: InternalQuestion, delayMs: number): void {
  if (q.timer) clearTimeout(q.timer);
  q.timer = setTimeout(() => questions.delete(q.questionId), delayMs);
  q.timer.unref?.();
}

function expire(q: InternalQuestion): void {
  if (q.status !== "pending") return;
  q.status = "expired";
  notifyWaiters(q);
  scheduleDeletion(q, PURGE_GRACE_MS);
}

export function createQuestion(
  chatId: string,
  question: string,
  timeoutSeconds?: number
): AskQuestionRecord {
  const ttlMs =
    Math.min(
      Math.max(timeoutSeconds ?? DEFAULT_QUESTION_TIMEOUT_SECONDS, 10),
      MAX_QUESTION_TIMEOUT_SECONDS
    ) * 1000;
  const now = Date.now();
  const q: InternalQuestion = {
    questionId: crypto.randomUUID(),
    chatId,
    question,
    status: "pending",
    createdAt: now,
    expiresAt: now + ttlMs,
    waiters: [],
  };
  q.timer = setTimeout(() => expire(q), ttlMs);
  q.timer.unref?.();
  questions.set(q.questionId, q);
  return toPublic(q);
}

export function setQuestionMessageId(questionId: string, messageId: number): void {
  const q = questions.get(questionId);
  if (q) q.messageId = messageId;
}

/** Remove a question that could not be delivered (e.g. the Telegram send failed). */
export function cancelQuestion(questionId: string): void {
  const q = questions.get(questionId);
  if (!q) return;
  if (q.timer) clearTimeout(q.timer);
  questions.delete(questionId);
}

export function getQuestion(questionId: string): AskQuestionRecord | null {
  const q = questions.get(questionId);
  return q ? toPublic(q) : null;
}

/** Most recently created question, optionally scoped to a chat. */
export function getLatestQuestion(chatId?: string): AskQuestionRecord | null {
  let latest: InternalQuestion | undefined;
  for (const q of questions.values()) {
    if (chatId && q.chatId !== chatId) continue;
    // >= so creation-order (Map insertion order) breaks same-millisecond ties
    if (!latest || q.createdAt >= latest.createdAt) latest = q;
  }
  return latest ? toPublic(latest) : null;
}

/**
 * Try to consume an incoming Telegram message as the answer to a pending
 * question. An explicit reply only matches the question message it targets
 * (ForceReply makes clients set this automatically); a plain message falls
 * back to the oldest pending question in the chat. Returns true when the
 * message was consumed — it must then NOT be forwarded to the target MCP.
 */
export function tryResolveFromMessage(
  chatId: string,
  text: string,
  opts: { replyToMessageId?: number; answeredBy?: string } = {}
): boolean {
  const pending = [...questions.values()]
    .filter((q) => q.chatId === chatId && q.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt);
  if (pending.length === 0) return false;

  const target =
    opts.replyToMessageId !== undefined
      ? pending.find((q) => q.messageId === opts.replyToMessageId)
      : pending[0];
  if (!target) return false;

  target.status = "answered";
  target.answer = text;
  target.answeredBy = opts.answeredBy;
  target.answeredAt = Date.now();
  notifyWaiters(target);
  // Keep the answered record available until the question's original expiry
  // (plus grace) so a client that lost its connection can still fetch it.
  scheduleDeletion(target, Math.max(target.expiresAt - Date.now(), 0) + PURGE_GRACE_MS);
  return true;
}

/**
 * Wait up to waitSeconds (capped at MAX_WAIT_SECONDS) for the question to be
 * answered or to expire. Resolves immediately if it is already resolved or
 * waitSeconds is 0. Returns null for unknown questionIds.
 */
export function waitForAnswer(
  questionId: string,
  waitSeconds: number
): Promise<AskQuestionRecord | null> {
  const q = questions.get(questionId);
  if (!q) return Promise.resolve(null);
  const waitMs = Math.min(Math.max(waitSeconds, 0), MAX_WAIT_SECONDS) * 1000;
  if (q.status !== "pending" || waitMs <= 0) return Promise.resolve(toPublic(q));

  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const notify = () => {
      if (timer) clearTimeout(timer);
      resolve(toPublic(q));
    };
    timer = setTimeout(() => {
      q.waiters = q.waiters.filter((w) => w !== notify);
      resolve(toPublic(q));
    }, waitMs);
    timer.unref?.();
    q.waiters.push(notify);
  });
}
