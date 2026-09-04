/**
 * IM-gateway channel type model (pure types, no runtime deps).
 *
 * Kept separate from `schema.ts` so the browser (client) half can import the
 * shape types without pulling the schemastery value-import (which is host-only
 * and must not be bundled into the client). No `import` statements with values
 * may be added here.
 */

/** The channel kinds the gateway can manage. */
export type ChannelType =
  | 'wechat'   // 微信（clawbot companion）
  | 'qq'       // QQ（icqq bot，扫码登录）
  | 'email'    // email（SMTP/IMAP 收发）
  | 'cmcc'     // 中国移动 新消息 / 5G消息 (WebSocket)
  | 'feishu'   // 飞书（官方 bot，长连接）
  | 'http'     // 通用 HTTP 回调（既有的 im-gateway webhook）

/**
 * Per-channel wiring. Non-secret fields are returned to the client over the
 * wire; SECRET fields (`role('secret')` in the schema) are redacted on every
 * wire boundary and only ever readable by the host via the settings scope.
 */
export interface ChannelConfig {
  /** Stable channel id. */
  id: string
  /** Channel kind. */
  type: ChannelType
  /** User-facing display name. */
  name: string
  /** Whether the gateway should hold this channel connected. */
  enabled: boolean
  /** Human note (optional). */
  note?: string

  // ---- agent routing (all channels) ----
  provider?: string
  model?: string
  cwd?: string
  agentPreset?: string
  disposeAfterReply?: boolean
  /** Positive output-token cap for turns on this channel (0/absent = runtime default). */
  maxTokens?: number
  /**
   * Sender allowlist for this channel. Non-empty ⇒ only these senderIds may
   * drive the agent; everyone else (or sender-less messages) is denied up front.
   * Empty/absent = allow all (rely on transport auth / private network).
   */
  allowlist?: string[]

  // ---- email ----
  host?: string
  imapPort?: number
  smtpPort?: number
  useTls?: boolean
  account?: string
  inbox?: string
  password?: string // SECRET (role('secret'))

  // ---- cmcc (5G消息) ----
  serverUrl?: string
  uploadUrl?: string
  version?: string
  apiKey?: string // SECRET

  // ---- http (generic webhook) ----
  inboundPath?: string
  chatIdField?: string
  textField?: string
  senderField?: string
  callbackUrl?: string
  callbackChatHeader?: string
  secret?: string // SECRET

  // ---- feishu ----
  appId?: string
  appSecret?: string // SECRET

  // ---- wechat (clawbot companion) ----
  clawUrl?: string
  token?: string // SECRET

  // ---- qq ----
  qq?: string
  qqPassword?: string // SECRET (password login; QR preferred)
}

/** Resolved shape of the whole `im-channels` settings section. */
export interface ChannelsSettings {
  /** Ordered list of configured channels. */
  channels: ChannelConfig[]
}

/** Connection lifecycle state surfaced to the UI (live via RPC). */
export type ChannelStatus = 'idle' | 'connecting' | 'connected' | 'error'
