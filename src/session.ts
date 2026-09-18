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
 * An optional `workspace` (an EXPLICITLY configured working directory — the
 * channel's own `cwd` or the plugin-wide default from the settings card) is
 * folded in as well, because a DSH session's cwd is pinned when the session is
 * created: `resume` restores the persisted header, and the workspace registry
 * refuses to attach a session whose header cwd differs from the workspace path.
 * A conversation therefore LIVES in one workspace, and pointing a channel at a
 * different directory has to start a new conversation there — silently resuming
 * the old one is what made a changed working directory look ignored. Leaving
 * `workspace` empty keeps the historical key, so every chat that never
 * configured a directory keeps its existing session (no one is reset).
 *
 * Kept dependency-light (only `node:crypto`) so it can be unit-tested without
 * loading the DSH agent/session runtime stack. The host wraps this string in a
 * `SessionId(...)` value where an actual session id is required.
 * @param chatId - external chat id (the peer/group the message came from).
 * @param namespace - receiving channel instance id, or '' for the historical bare key.
 * @param workspace - explicit working directory, or '' when none is configured.
 * @param prefix - session-id prefix ('im' by default).
 * @returns the deterministic session id for this chat/channel/workspace triple.
 */
export function sessionIdForChat(chatId: string, namespace = '', workspace = '', prefix = 'im'): string {
  const scope = namespace !== '' ? `${namespace}:${chatId}` : chatId
  const key = normalizeWorkspace(workspace)
  const seed = key !== '' ? `${scope}@${key}` : scope
  const digest = createHash('sha1').update(seed).digest('hex').slice(0, 16)
  return `${prefix}-${digest}`
}

/**
 * Canonicalize one configured working directory for IDENTITY purposes: a typed
 * path is the same workspace with or without surrounding whitespace and a
 * trailing separator (`C:\work\im\` ≡ `C:\work\im`), so both must hash alike or
 * a harmless edit would silently start a new conversation. Roots (`C:\`, `/`)
 * are kept verbatim — dropping their separator would name something else
 * (a drive-relative path).
 * @param workspace - the raw configured directory.
 * @returns the identity form, or '' when nothing is configured.
 */
function normalizeWorkspace(workspace: string): string {
  const trimmed = workspace.trim()
  if (trimmed === '') return ''
  const cut = trimmed.replace(/[\\/]+$/, '')
  return cut === '' || cut.endsWith(':') ? trimmed : cut
}
