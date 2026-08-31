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
  | 'wechat'   // 微信（占位：个人号无官方接口，仅接入引导）
  | 'qq'       // QQ（占位）
  | 'email'    // email（SMTP 收/发）
  | 'cmcc'     // 中国移动 新消息 / 5G消息 (WebSocket)
  | 'feishu'   // 飞书（占位/扫码）
  | 'http'     // 通用 HTTP 回调（既有的 im-gateway webhook）

/**
 * Non-secret, per-channel wiring. Every field is optional except `id`/`type`;
 * a channel's secrets are referenced by ref and fetched via credentials.
 */
export interface ChannelConfig {
  /** Stable channel id (e.g. "wechat-work", "imap-liam"). */
  id: string
  /** Channel kind. */
  type: ChannelType
  /** User-facing display name. */
  name: string
  /** Whether the gateway should hold this channel connected. */
  enabled: boolean
  /** Human note (optional). */
  note?: string

  // email
  host?: string
  imapPort?: number
  smtpPort?: number
  useTls?: boolean
  account?: string

  // cmcc (5G消息)
  serverUrl?: string
  uploadUrl?: string
  version?: string

  // http (generic webhook)
  inboundPath?: string
  chatIdField?: string
  textField?: string
  callbackUrl?: string
  callbackChatHeader?: string

  // base agent routing
  provider?: string
  model?: string
  cwd?: string
  agentPreset?: string
}

/** Resolved shape of the whole `im-channels` settings section. */
export interface ChannelsSettings {
  /** Ordered list of configured channels. */
  channels: ChannelConfig[]
}

/** Connection lifecycle state surfaced to the UI (mirrored on demand). */
export type ChannelStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'placeholder'
