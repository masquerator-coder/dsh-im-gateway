import { createHash } from 'node:crypto'

/**
 * Deterministic, stable session-key string derived from an external chat id.
 *
 * An optional `namespace` (the receiving channel, e.g. `cmcc` / `email`, or a
 * `botId`) is folded into the seed BEFORE hashing, so two channels sharing the
 * same external chat id still get distinct, isolated sessions — mirroring
 * dsh-im-main's `ConversationRoute` isolation of channel + bot entirely from a
 * bare peer id. An empty namespace keeps the historical chatId-only key, so
 * callers that don't (yet) know their channel stay backward compatible.
 *
 * Kept dependency-light (only `node:crypto`) so it can be unit-tested without
 * loading the DSH agent/session runtime stack. The host wraps this string in a
 * `SessionId(...)` value where an actual session id is required.
 */
export function sessionIdForChat(chatId: string, namespace = '', prefix = 'im'): string {
  const seed = namespace !== '' ? `${namespace}:${chatId}` : chatId
  const digest = createHash('sha1').update(seed).digest('hex').slice(0, 16)
  return `${prefix}-${digest}`
}
