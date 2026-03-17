import { MessageContext } from "./types";

const TEMPLATE_REGEX = /\{\{(\w+)\}\}/g;

export function resolveTemplate(template: unknown, context: MessageContext): unknown {
  if (typeof template === "string") {
    return resolveStringTemplate(template, context);
  }

  if (Array.isArray(template)) {
    return template.map((item) => resolveTemplate(item, context));
  }

  if (template !== null && typeof template === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      result[key] = resolveTemplate(value, context);
    }
    return result;
  }

  return template;
}

function resolveStringTemplate(template: string, context: MessageContext): string {
  return template.replace(TEMPLATE_REGEX, (match, variable) => {
    const value = getContextValue(context, variable);
    if (value === undefined) {
      console.warn(`Template variable not found: ${variable}`);
      return match;
    }
    return String(value);
  });
}

function getContextValue(context: MessageContext, key: string): unknown {
  const contextRecord = context as unknown as Record<string, unknown>;
  return contextRecord[key];
}

export function createMessageContext(
  text: string,
  chatId: string | number,
  userId: string | number,
  username: string | undefined,
  firstName: string,
  lastName: string | undefined,
  messageId: number,
  date: number,
  isBot: boolean,
  languageCode: string | undefined,
  permissionCallbackUrl?: string,
  defaultChatId?: string
): MessageContext {
  return {
    text,
    chatId: String(chatId),
    userId: String(userId),
    username,
    firstName,
    lastName,
    messageId,
    date,
    isBot,
    languageCode,
    permissionCallbackUrl,
    defaultChatId,
  };
}
