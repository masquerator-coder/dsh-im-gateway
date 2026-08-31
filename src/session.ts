import { createHash } from 'node:crypto'

/**
 * Deterministic, stable session-key string derived from an external chat id.
 *
 * Kept dependency-light (only `node:crypto`) so it can be unit-tested without
 * loading the DSH agent/session runtime stack. The host wraps this string in a
 * `SessionId(...)` value where an actual session id is required.
 */
export function sessionIdForChat(chatId: string, prefix = 'im'): string {
  const digest = createHash('sha1').update(chatId).digest('hex').slice(0, 16)
  return `${prefix}-${digest}`
}
