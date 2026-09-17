/**
 * QQ "bot" transport — official QQ Open Platform (q.qq.com) robot over the
 * WebSocket event gateway, the QQ channel's only transport. Create a robot at
 * https://q.qq.com, get its `appId` + `appSecret`, and this transport handles
 * token acquisition → gateway discovery → WebSocket IDENTIFY/RESUME/heartbeat →
 * C2C/group message dispatch.
 *
 * Protocol (official docs, 2026-09):
 *   1. token   POST https://api.bot.qq.com/app/getAppAccessToken
 *              body { appId, clientSecret } -> { access_token, expires_in (7200s) }
 *              NOTE: failures come back as HTTP **200** with `{ code, message }`
 *              (100007 appid invalid / 100016 invalid appid or secret), so the
 *              body — not the status — decides success.
 *   2. gateway GET {apiBase}/gateway, header `Authorization: QQBot <token>`
 *              -> { url: wss://... }
 *   3. WS      connect, then: op=10 Hello -> op=2 IDENTIFY (or op=6 RESUME when
 *              a session id + seq survive from the previous connection)
 *              { d:{ token, intents, shard:[0,1] } }
 *              - op=1 heartbeat every heartbeat_interval, payload d = last seq
 *                (null until the first dispatch), answered by op=11 ACK
 *              - op=0 Dispatch: C2C_MESSAGE_CREATE (1<<25), GROUP_AT_MESSAGE_CREATE
 *                (1<<25), AT_MESSAGE_CREATE (1<<30), DIRECT_MESSAGE_CREATE (1<<12)
 *   4. send    C2C  POST {apiBase}/v2/users/{openid}/messages
 *              group POST {apiBase}/v2/groups/{group_openid}/messages
 *              dms   POST {apiBase}/dms/{guild_id}/messages
 *
 * Whatever the gateway refuses (bad credentials, an intent the robot has not
 * been granted, a revoked session) is reported to the panel as the *actual*
 * reason: a QQ bot that silently reconnects every few seconds and never says
 * why is indistinguishable from "QQ 连不上".
 *
 * Chat identity: the external `openid` (per-bot opaque user id) is used as the
 * chatId for session keying, exactly like the other channels. Outbound replies
 * must be *passive* (carry the inbound msg_id) for C2C / group — matching the
 * gateway's rules: the msg_id is valid for 5 minutes and each inbound message
 * accepts at most 5 replies (`msg_seq` numbers them; the same msg_id + msg_seq
 * is rejected as a duplicate).
 *
 * > Limits: group/C2C robot capabilities must be granted on q.qq.com (提审);
 * > before approval the gateway closes the connection with 4014 (intent 无权限)
 * > — expected until the application passes review.
 */

import WebSocket from 'ws'
import type { ChannelTransport, InboundRoute } from './types.ts'

/** Canonical access-token endpoint (docs 2026-09). */
export const DEFAULT_TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken'
/** Legacy token host (what the pre-2026-09 docs used; still answered). */
export const LEGACY_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
/** Canonical OpenAPI base (docs 2026-09: 统一请求地址). */
export const DEFAULT_QQ_API_BASE = 'https://api.bot.qq.com'
/** Legacy OpenAPI base — still served, and the prefill older records carry. */
export const LEGACY_QQ_API_BASE = 'https://api.sgroup.qq.com'
/** Sandbox OpenAPI base (`sandbox: true`). */
export const SANDBOX_QQ_API_BASE = 'https://sandbox.api.sgroup.qq.com'

/** WS connect/open timeout. */
const CONNECT_TIMEOUT_MS = 20000
/** How long to wait for Hello after the socket opens. */
const HELLO_TIMEOUT_MS = 15000
/** How long to wait for READY/RESUMED after IDENTIFY/RESUME. */
const READY_TIMEOUT_MS = 15000
/** HTTP timeout for token / gateway / send calls. */
const HTTP_TIMEOUT_MS = 15000
/** Reconnect backoff bounds (exponential). */
const BASE_RECONNECT_MS = 3000
const MAX_RECONNECT_MS = 60000
/**
 * Heartbeat-ACK watchdog grace: the gateway ACKs every client heartbeat, so if
 * nothing at all arrives within two intervals (plus slack) the socket is dead
 * even though it still reports OPEN — the classic half-open connection after a
 * sleep/network change, which used to leave the panel green for ever.
 */
const WATCHDOG_GRACE_MS = 5000
/**
 * Conservative text chunk size for one passive reply. The platform rejects
 * oversized content (`40054007 消息长度超限`) and allows at most 5 replies per
 * inbound message, so a long agent answer is split into a few numbered
 * messages rather than lost whole.
 */
const TEXT_CHUNK_MAX = 900
/** Per-inbound-message passive reply quota (official: 每个消息最多回复 5 次). */
const PASSIVE_REPLY_MAX = 5

/**
 * Event-subscription intent bits (official). Only `guilds`, `publicGuildMessages`
 * and `guildMembers` are granted by default; every other bit must be applied
 * for on q.qq.com — IDENTIFYing with an un-granted bit makes the gateway close
 * the connection immediately (4014) instead of just dropping those events.
 */
export const QQ_INTENT = {
  guilds: 1 << 0,
  guildMembers: 1 << 1,
  guildMessages: 1 << 9,
  directMessage: 1 << 12,
  groupAndC2C: 1 << 25,
  interaction: 1 << 26,
  messageAudit: 1 << 27,
  forumsEvent: 1 << 28,
  audioAction: 1 << 29,
  publicGuildMessages: 1 << 30,
} as const

/**
 * Default subscription: C2C/群聊 (the reason to run a QQ robot at all) plus the
 * default-allowed public-guild @-messages. `directMessage` is deliberately NOT
 * requested: it is a guild-only capability that needs its own approval, and
 * asking for it by default would make an unapproved robot fail to connect even
 * for C2C/group use.
 */
export const DEFAULT_INTENTS = QQ_INTENT.groupAndC2C | QQ_INTENT.publicGuildMessages

/** Every bit this transport knows how to name (used to validate a spec). */
const KNOWN_INTENT_MASK = Object.values(QQ_INTENT).reduce((acc, bit) => acc | bit, 0)

/** Human-readable aliases accepted by {@link parseIntents}. */
const INTENT_ALIASES: Record<string, number> = {
  c2c: QQ_INTENT.groupAndC2C,
  group: QQ_INTENT.groupAndC2C,
  单聊: QQ_INTENT.groupAndC2C,
  群聊: QQ_INTENT.groupAndC2C,
  public_guild: QQ_INTENT.publicGuildMessages,
  publicguild: QQ_INTENT.publicGuildMessages,
  公域频道: QQ_INTENT.publicGuildMessages,
  direct: QQ_INTENT.directMessage,
  dm: QQ_INTENT.directMessage,
  私信: QQ_INTENT.directMessage,
  interaction: QQ_INTENT.interaction,
  互动: QQ_INTENT.interaction,
  guilds: QQ_INTENT.guilds,
  guild_members: QQ_INTENT.guildMembers,
  guild_messages: QQ_INTENT.guildMessages,
  audit: QQ_INTENT.messageAudit,
  forums: QQ_INTENT.forumsEvent,
  audio: QQ_INTENT.audioAction,
}

/** Intent keyword list for help/hint text. */
export const INTENT_KEYWORDS = 'c2c|group, public_guild, direct, interaction, guilds, guild_members, guild_messages, audit, forums, audio'

/**
 * Parse an event-subscription spec: either a decimal bitmask or a list of
 * keywords / numbers separated by `,` `|` `+` or whitespace (e.g.
 * `"c2c,public_guild"` or `"33554432|1073741824"`).
 * @param spec - configured value (undefined/empty -> {@link DEFAULT_INTENTS}).
 * @returns the intent bitmask.
 * @throws {QqFatalError} when a token is unknown or a bit does not exist.
 */
export function parseIntents(spec: string | number | undefined): number {
  if (spec === undefined || spec === null) return DEFAULT_INTENTS
  if (typeof spec === 'number') {
    if (!Number.isFinite(spec) || spec <= 0) throw new QqFatalError(`intents 数值无效：${String(spec)}`)
    return validateIntents(spec)
  }
  const text = spec.trim()
  if (text === '') return DEFAULT_INTENTS
  if (/^\d+$/.test(text)) return validateIntents(Number(text))
  let mask = 0
  for (const raw of text.split(/[,|+\s]+/)) {
    if (raw === '') continue
    if (/^\d+$/.test(raw)) {
      mask |= Number(raw)
      continue
    }
    const bit = INTENT_ALIASES[raw.toLowerCase()]
    if (bit === undefined) {
      throw new QqFatalError(`无法识别的 intents 片段「${raw}」（可用：${INTENT_KEYWORDS}，或直接填十进制位掩码）`)
    }
    mask |= bit
  }
  if (mask === 0) throw new QqFatalError(`intents 未包含任何事件类型：${text}`)
  return validateIntents(mask)
}

function validateIntents(mask: number): number {
  const unknown = mask & ~KNOWN_INTENT_MASK
  if (unknown !== 0) {
    throw new QqFatalError(`intents 含未知事件位：${unknown}（已知位掩码最大到 1<<30）`)
  }
  return mask
}

/**
 * Non-recoverable transport failure: retrying cannot fix it (bad credentials,
 * an intent the robot was never granted, a banned/removed robot). The transport
 * reports it and stops reconnecting so the real reason stays on the panel
 * instead of scrolling past in the host log.
 */
export class QqFatalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QqFatalError'
  }
}

/** One failed OpenAPI response. */
export interface QqApiFailure {
  code: number
  message: string
  /** True when retrying the same call cannot succeed without a config change. */
  fatal: boolean
}

/** Chinese explanations for the API codes this transport can meet. */
const API_CODE_HINT: Record<number, string> = {
  100001: '请求过于频繁，请稍后重试',
  100007: 'AppID 无效，或机器人状态不正常（被封禁/已删除）',
  100016: 'AppID 或 AppSecret 不正确',
  10004: 'AppID 对应的机器人不存在',
  11244: 'AccessToken 无效或过期',
  11251: '鉴权失败：AppID/凭证不正确',
  11253: '该机器人未获得调用此接口的权限（需在 q.qq.com 申请）',
  11254: '该机器人的此接口已被封禁',
  11265: '机器人已被封禁',
  304018: '机器人没有连上 QQ 网关（WebSocket 未就绪）',
}

/** Codes that need a config/approval change before they can ever succeed. */
const FATAL_API_CODES = new Set([100007, 100016, 10004, 11251, 11253, 11254, 11262, 11265])

/** Chinese explanations for message-send error codes (official 排查建议). */
const SEND_CODE_HINT: Record<number, string> = {
  304103: '消息 ID 已过期，不能回复（需在收到消息后 5 分钟内回复）',
  40034005: '被动回复的 msg_id 已过期（有效期 5 分钟）',
  40034024: '请求参数 msg_id 无效或越权',
  40034101: '机器人非群成员，请先把机器人加入群聊',
  40034105: '主动消息发送失败：无权限（用户可能未开启主动消息推送）',
  40034128: '被动回复时间或次数超限（同一条消息最多回复 5 次）',
  40054002: '机器人被禁言，请等待解禁',
  40054003: '机器人不是群成员，请先把机器人加入群聊',
  40054005: '消息被去重（相同的 msg_id + msg_seq 已发送过）',
  40054007: '消息长度超限，请缩短消息内容',
  40054010: '不允许发送 URL，请移除消息中的链接',
  40054016: '机器人已下线，请检查机器人状态',
  50055001: '消息发送异常，请稍后重试',
  304064: '订阅消息未授权（需用户在机器人资料页开启主动消息）',
}

/** Passive-reply rejections that主动消息 (a reply without msg_id) can rescue. */
const PASSIVE_EXPIRED_CODES = new Set([304103, 40034005, 40034024, 40034128])

/**
 * Explain one API error code (falls back to the platform's own message).
 * @param code - `err_code` / `code` from the response body.
 * @param message - the platform's message (may be empty or unstable).
 * @returns a human-readable Chinese reason.
 */
export function describeApiCode(code: number, message?: string): string {
  return API_CODE_HINT[code] ?? SEND_CODE_HINT[code] ?? (message && message.trim() !== '' ? message : `错误码 ${code}`)
}

/** One WS close code's meaning + what the client should do next. */
export interface CloseDiagnosis {
  /** Chinese explanation surfaced to the panel. */
  reason: string
  /** `resume` keeps the session, `identify` starts a fresh one, `stop` gives up. */
  action: 'resume' | 'identify' | 'stop'
  /** Actionable next step for the operator (fatal codes only). */
  hint?: string
}

/**
 * Diagnose a QQ gateway close code (official table).
 * @param code - the WebSocket close code.
 * @returns the reason, the retry strategy, and (for fatal codes) the fix.
 */
export function diagnoseClose(code: number): CloseDiagnosis {
  switch (code) {
    case 4001: return { reason: '无效的 opcode（协议实现错误）', action: 'stop' }
    case 4002: return { reason: '无效的 payload（协议实现错误）', action: 'stop' }
    case 4006: return { reason: '无效的 session id，需要重新鉴权（IDENTIFY）', action: 'identify' }
    case 4007: return { reason: 'seq 错误，需要重新鉴权（IDENTIFY）', action: 'identify' }
    case 4008: return { reason: '发送 payload 过快（触发网关频控）', action: 'identify' }
    case 4009: return { reason: '连接过期，需重连并 RESUME 补发遗漏事件', action: 'resume' }
    case 4010: return { reason: '无效的 shard', action: 'stop' }
    case 4011: return { reason: '需要处理的频道过多，必须分片', action: 'stop' }
    case 4012: return { reason: '无效的 version', action: 'stop' }
    case 4013: {
      return {
        reason: '无效的 intent（订阅的事件位不合法）',
        action: 'stop',
        hint: `当前 intents=${DEFAULT_INTENTS} 为默认值；请检查通道 intents 配置是否正确（可用：${INTENT_KEYWORDS}）`,
      }
    }
    case 4014: {
      return {
        reason: 'intent 无权限：机器人未被授予所订阅事件的权限',
        action: 'stop',
        hint: '请在 q.qq.com 为该机器人申请/开通对应事件权限（例如「单聊 / 群聊」能力需提审通过）'
          + `，或先把通道的 intents 改成只订阅已有权限的事件（如 public_guild）后重新保存本通道`,
      }
    }
    case 4914: {
      return {
        reason: '机器人已下架，只允许连接沙箱环境',
        action: 'stop',
        hint: '请检查机器人状态，或在通道里把「沙箱环境」打开后重新保存',
      }
    }
    case 4915: {
      return {
        reason: '机器人已封禁，不允许连接',
        action: 'stop',
        hint: '请在开放平台申请解封后再试',
      }
    }
    default: break
  }
  if (code >= 4900 && code <= 4913) {
    return { reason: `网关内部错误（${code}），需重连`, action: 'identify' }
  }
  if (code >= 4000 && code <= 4999) {
    return { reason: `网关拒绝连接（关闭码 ${code}）`, action: 'identify' }
  }
  return { reason: `连接断开（关闭码 ${code}）`, action: 'identify' }
}

/**
 * Split one agent reply into sendable chunks: the platform rejects oversized
 * content, and each inbound message accepts at most 5 passive replies. Text
 * beyond that quota is truncated with a visible marker rather than dropped
 * silently.
 * @param text - the reply text.
 * @returns 1..{@link PASSIVE_REPLY_MAX} non-empty chunks.
 */
export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n')
  if (clean.trim() === '') return []
  const chunks: string[] = []
  let rest = clean
  while (rest !== '' && chunks.length < PASSIVE_REPLY_MAX) {
    if (rest.length <= TEXT_CHUNK_MAX) {
      chunks.push(rest)
      rest = ''
      break
    }
    // Prefer a newline boundary so a chunk never cuts a line in half.
    const window = rest.slice(0, TEXT_CHUNK_MAX)
    const cut = window.lastIndexOf('\n')
    const end = cut > TEXT_CHUNK_MAX / 2 ? cut : TEXT_CHUNK_MAX
    chunks.push(rest.slice(0, end))
    rest = rest.slice(end).replace(/^\n+/, '')
  }
  if (rest !== '' && chunks.length >= PASSIVE_REPLY_MAX) {
    const last = chunks[chunks.length - 1]!
    chunks[chunks.length - 1] = `${last}\n…（内容过长，已截断）`
  }
  return chunks
}

/** Identifies the sender/peer kind of an inbound message. */
type PeerKind = 'c2c' | 'group' | 'dm'

export interface QQBotOptions {
  appId: string
  clientSecret: string
  /** Api base (defaults to https://api.bot.qq.com; legacy/sandbox overridable). */
  apiBase?: string
  /** sandbox=true uses https://sandbox.api.sgroup.qq.com. */
  sandbox?: boolean
  /** Token endpoint override (tests / self-hosted gateway). */
  tokenUrl?: string
  /**
   * Event subscription: decimal bitmask or keyword list (see
   * {@link parseIntents}). Defaults to C2C/群聊 + 公域频道@.
   */
  intents?: number | string
  provider?: string
  model?: string
  maxTokens?: number
  disposeAfterReply?: boolean
  onInbound: (route: InboundRoute) => void
  log?: (msg: string) => void
  /** Connection state callback (detail is shown verbatim on the panel). */
  onState?: (status: 'connecting' | 'connected' | 'error' | 'idle', detail?: string) => void
}

/** Pending send for one peer, keyed by external id + kind. */
interface QqTarget {
  kind: PeerKind
  id: string
}

/** A pending handshake (Hello → IDENTIFY/RESUME → READY/RESUMED). */
interface Handshake {
  settle: (error?: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Official QQ bot transport. Owns the token cache, gateway discovery, the
 * WebSocket event loop (IDENTIFY / RESUME / heartbeat with an ACK watchdog) and
 * C2C/group message dispatch, routing every inbound message through the gateway
 * and sending agent replies back via the REST send endpoints.
 */
export class QQBotTransport implements ChannelTransport {
  private ws: WebSocket | null = null
  private connected = false
  private token = ''
  private tokenExpiresAt = 0
  private seq: number | null = null
  /** Gateway session id (from READY) — required to RESUME without losing events. */
  private sessionId = ''
  private heartbeatTimer: NodeJS.Timeout | null = null
  private watchdogTimer: NodeJS.Timeout | null = null
  private heartbeatIntervalMs = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private desiredConnected = false
  /** True once READY/RESUMED arrived on the current socket. */
  private ready = false
  /** Guards against overlapping connect() runs (config edits + retries). */
  private connecting = false
  /** Last frame of ANY kind: the liveness signal the watchdog watches. */
  private lastFrameAt = 0
  private handshake: Handshake | null = null
  private readonly intents: number
  /** External id -> peer kind map used for reply routing. */
  private readonly targets = new Map<string, QqTarget>()
  /** External id -> last inbound msg_id (required for passive group/C2C replies). */
  private readonly lastMsgId = new Map<string, string>()
  /** External id -> passive-reply numbering (msg_id + msg_seq must be unique). */
  private readonly replySeq = new Map<string, { msgId: string; seq: number }>()

  constructor(private readonly options: QQBotOptions) {
    this.intents = parseIntents(options.intents)
  }

  get apiBase(): string {
    if (this.options.sandbox) return SANDBOX_QQ_API_BASE
    return (this.options.apiBase || DEFAULT_QQ_API_BASE).replace(/\/+$/, '')
  }

  get tokenUrl(): string {
    return this.options.tokenUrl || DEFAULT_TOKEN_URL
  }

  /** The intents actually sent at IDENTIFY (asserted by the smoke test). */
  get subscribedIntents(): number {
    return this.intents
  }

  async start(): Promise<void> {
    if (this.desiredConnected) return
    if (!this.options.appId) {
      throw new QqFatalError('缺少 AppID：请在 q.qq.com 创建机器人，并把 AppID / AppSecret 填入本通道')
    }
    if (!this.options.clientSecret) {
      throw new QqFatalError('缺少 AppSecret：请在 q.qq.com 的机器人开发设置里复制 AppSecret 并填入本通道')
    }
    this.desiredConnected = true
    this.options.onState?.('connecting', '正在连接 QQ 开放平台网关…')
    await this.connect()
  }

  isConnected(): boolean {
    return this.connected
  }

  // ── HTTP helpers ───────────────────────────────────────────────────────────

  /**
   * Fetch a fresh QQ bot access_token (cached until near expiry). A failure is
   * reported as HTTP 200 + `{ code, message }`, so the body decides — reporting
   * "token missing in response" for an invalid AppSecret sent the operator
   * looking in the wrong place.
   */
  private async getToken(force = false): Promise<string> {
    const now = Date.now()
    if (!force && this.token && this.tokenExpiresAt > now + 60_000) return this.token
    const resp = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.options.appId, clientSecret: this.options.clientSecret }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    const text = await resp.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* non-json body */ }
    const body = json && typeof json === 'object' ? json : null
    const token = String((body && body.access_token) || '')
    if (token) {
      this.token = token
      const expiresIn = Number(body && body.expires_in) || 7200
      this.tokenExpiresAt = Date.now() + expiresIn * 1000
      return token
    }
    const failure = apiFailure(resp.status, body, text)
    const code = failure ? failure.code : resp.status
    const detail = describeApiCode(code, failure?.message)
    const message = `获取 QQ AccessToken 失败：${detail}（code ${code}）`
    // Credential errors cannot be fixed by retrying with the same values.
    if (!failure || failure.fatal || code === 100007 || code === 100016 || code === 10004) {
      throw new QqFatalError(`${message} —— 请核对 AppID / AppSecret（q.qq.com → 开发设置）后重新保存本通道`)
    }
    throw new Error(message)
  }

  private async qqFetch(
    url: string,
    opts: { method?: string; body?: unknown; retryOnAuthFailure?: boolean } = {},
  ): Promise<{ status: number; json: any; text: string }> {
    const token = await this.getToken()
    const resp = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    const text = await resp.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* non-json */ }
    const failure = apiFailure(resp.status, json, text)
    // A cached token can be revoked early (11244): refresh once and retry, so a
    // stale in-memory token never looks like "QQ 连不上".
    if (
      failure !== null && failure.code === 11244
      && opts.retryOnAuthFailure !== false
    ) {
      this.options.log?.('qq bot access token rejected (11244); refreshing and retrying once')
      this.token = ''
      this.tokenExpiresAt = 0
      await this.getToken(true)
      return this.qqFetch(url, { ...opts, retryOnAuthFailure: false })
    }
    return { status: resp.status, json, text }
  }

  // ── WebSocket lifecycle ────────────────────────────────────────────────────

  /** Discover the gateway and complete one handshake. Throws on failure. */
  private async connect(): Promise<void> {
    if (this.connecting) return
    this.connecting = true
    try {
      const token = await this.getToken()
      const gwResp = await this.qqFetch(`${this.apiBase}/gateway`)
      const failure = apiFailure(gwResp.status, gwResp.json, gwResp.text)
      if (failure !== null) {
        const detail = `获取 QQ 网关地址失败：${describeApiCode(failure.code, failure.message)}（code ${failure.code}）`
        if (failure.fatal) throw new QqFatalError(`${detail} —— 请在 q.qq.com 检查机器人状态/权限后重新保存本通道`)
        throw new Error(detail)
      }
      // QQ API wraps results as { code, message, data }; some deployments return
      // the url at the top level. Handle both.
      const json = gwResp.json || {}
      const dataUrl = (json.data && json.data.url) || json.url
      const gatewayUrl = typeof dataUrl === 'string' ? dataUrl : ''
      if (!gatewayUrl) {
        throw new Error(`获取 QQ 网关地址失败：响应里没有 url（HTTP ${gwResp.status}）${gwResp.text.slice(0, 120)}`)
      }
      await this.openSocket(gatewayUrl, token)
    } catch (error) {
      const fatal = error instanceof QqFatalError
      const message = error instanceof Error ? error.message : String(error)
      this.options.log?.(`qq bot connect failed: ${message}`)
      // A non-recoverable failure must stop the reconnect loop: retrying every
      // few seconds forever is what buried the real reason in the host log.
      if (fatal) this.desiredConnected = false
      const stopped = !this.desiredConnected
      // stop() already reported 'idle' — never overwrite it with a stale error.
      if (!stopped || fatal) this.options.onState?.('error', message)
      if (!stopped) this.scheduleReconnect()
      // start() rejects only when retrying cannot help (or the transport was
      // stopped meanwhile), because the manager reports that message on the panel.
      if (fatal || stopped) throw error
    } finally {
      this.connecting = false
    }
  }

  /**
   * Open the socket and drive it to READY/RESUMED. Resolves only once the
   * gateway accepted our IDENTIFY/RESUME — so a refused handshake (4013/4014)
   * reaches the caller (and the panel) instead of leaving a permanently
   * "connecting" channel behind.
   */
  private openSocket(gatewayUrl: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Never let two sockets coexist: a reconnect that overlaps the old
      // connection would double-deliver every event.
      this.closeSocket()
      let ws: WebSocket
      try {
        ws = new WebSocket(gatewayUrl, {
          headers: {
            Authorization: `QQBot ${token}`,
            'X-Union-Appid': this.options.appId,
          },
        })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      this.ws = ws
      this.handshake = {
        settle: (error?: Error): void => {
          if (error === undefined) resolve()
          else reject(error)
        },
        // Hello must arrive promptly; without this a socket that opens and then
        // says nothing kept the channel in "connecting" for ever.
        timer: setTimeout(() => {
          this.settleHandshake(new Error(`QQ 网关握手超时（${HELLO_TIMEOUT_MS / 1000} 秒内未收到 Hello）`))
          this.forceReconnect('QQ 网关握手超时，正在重连…')
        }, HELLO_TIMEOUT_MS),
      }

      const openTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) return
        this.settleHandshake(new Error(`QQ 网关 WebSocket 连接超时（${CONNECT_TIMEOUT_MS / 1000} 秒）`))
        try { ws.terminate() } catch { /* ignore */ }
      }, CONNECT_TIMEOUT_MS)

      ws.on('open', () => {
        clearTimeout(openTimer)
        this.lastFrameAt = Date.now()
        this.options.log?.('qq bot websocket open')
      })
      ws.on('message', (data) => {
        if (this.ws !== ws) return
        this.handleFrame(String(data))
      })
      ws.on('close', (code, reason) => {
        clearTimeout(openTimer)
        if (this.ws !== ws) return
        this.ws = null
        this.connected = false
        this.ready = false
        this.stopHeartbeat()
        const diagnosis = diagnoseClose(code)
        const why = reason.length > 0 ? `${diagnosis.reason}；reason=${reason.toString()}` : diagnosis.reason
        this.options.log?.(`qq bot websocket closed (code=${code} ${why})`)
        if (diagnosis.action === 'stop') {
          const fatal = new QqFatalError(
            `QQ 网关拒绝连接（关闭码 ${code}：${diagnosis.reason}）`
            + (diagnosis.hint ? ` —— ${diagnosis.hint}` : ''),
          )
          // Settle a pending start() so the panel shows the real reason…
          this.settleHandshake(fatal)
          // …and stop reconnecting: only a config change can fix this.
          this.desiredConnected = false
          this.options.onState?.('error', fatal.message)
          return
        }
        this.settleHandshake(new Error(`QQ 网关连接中断（关闭码 ${code}：${diagnosis.reason}）`))
        if (diagnosis.action === 'identify') {
          // Per the official table, everything except RESUME-able codes restarts
          // with a fresh IDENTIFY.
          this.sessionId = ''
          this.seq = null
        }
        if (!this.desiredConnected) return
        this.options.onState?.('connecting', `QQ 网关连接断开（关闭码 ${code}：${diagnosis.reason}），正在重连…`)
        this.scheduleReconnect()
      })
      ws.on('error', (error) => {
        this.options.log?.(`qq bot websocket error: ${error.message}`)
        this.settleHandshake(new Error(`QQ 网关 WebSocket 错误：${error.message}`))
      })
    })
  }

  private closeSocket(): void {
    const ws = this.ws
    this.ws = null
    if (ws === null) return
    ws.removeAllListeners()
    try { ws.terminate() } catch { /* ignore */ }
  }

  /** Close a (possibly half-open) socket and reconnect. */
  private forceReconnect(detail: string): void {
    this.connected = false
    this.ready = false
    this.options.onState?.('connecting', detail)
    this.options.log?.(`qq bot force reconnect: ${detail}`)
    this.closeSocket()
    this.stopHeartbeat()
    this.settleHandshake(new Error(detail))
    if (this.desiredConnected) this.scheduleReconnect()
  }

  /**
   * Settle the pending handshake (no-op when there is none), so a failing or
   * superseded connection never leaves `start()` hanging.
   * @param error - the failure to reject with; omit to resolve (connected).
   */
  private settleHandshake(error?: Error): void {
    const pending = this.handshake
    if (pending === null) return
    this.handshake = null
    clearTimeout(pending.timer)
    pending.settle(error)
  }

  private scheduleReconnect(): void {
    if (!this.desiredConnected || this.reconnectTimer) return
    this.reconnectAttempts++
    const delay = Math.min(
      BASE_RECONNECT_MS * Math.pow(2, this.reconnectAttempts - 1),
      MAX_RECONNECT_MS,
    )
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.options.log?.(`qq bot reconnect attempt ${this.reconnectAttempts}`)
      void this.connect().catch(() => { /* connect() already reported it */ })
    }, delay)
  }

  private handleFrame(raw: string): void {
    this.lastFrameAt = Date.now()
    let frame: any
    try { frame = JSON.parse(raw) } catch { return }
    if (!frame || typeof frame !== 'object') return
    const op = frame.op
    switch (op) {
      case 10: { // Hello — handshake starts here
        const d = frame.d || {}
        this.heartbeatIntervalMs = Number(d.heartbeat_interval) || 41250
        if (this.sessionId && this.seq !== null) {
          this.options.log?.('qq bot resuming session ' + this.sessionId)
          this.send({ op: 6, d: { token: `QQBot ${this.token}`, session_id: this.sessionId, seq: this.seq } })
        } else {
          this.sendOp2()
        }
        this.startHeartbeat(this.heartbeatIntervalMs)
        // IDENTIFY/RESUME must be answered by READY/RESUMED; a silent gateway is
        // the other way a channel could sit in "connecting" for ever.
        this.armReadyTimeout()
        break
      }
      case 0: { // Dispatch
        if (typeof frame.s === 'number') this.seq = frame.s
        const type = String(frame.t || '')
        if (type === 'READY') {
          const sessionId = frame.d && frame.d.session_id
          if (typeof sessionId === 'string' && sessionId) this.sessionId = sessionId
        }
        if (!this.ready) {
          this.ready = true
          this.connected = true
          this.reconnectAttempts = 0
          this.settleHandshake()
          this.options.onState?.('connected')
          this.options.log?.(`qq bot ready (${type || 'dispatch'}), intents=${this.intents}`)
        }
        this.dispatchEvent(type, frame.d || {})
        break
      }
      case 1: { // Gateway heartbeat (server-side ping)
        this.sendOp1()
        break
      }
      case 11: { // Heartbeat ACK — the watchdog's liveness signal
        break
      }
      case 7: { // Reconnect requested by the gateway
        this.forceReconnect('QQ 网关要求重连（op=7），正在重连…')
        break
      }
      case 9: { // Invalid Session — our IDENTIFY/RESUME payload was rejected
        this.options.log?.('qq bot invalid session (op=9); next connection will IDENTIFY')
        this.sessionId = ''
        this.seq = null
        this.settleHandshake(new Error('QQ 网关拒绝了本次鉴权（op=9 Invalid Session）'))
        try { this.ws?.close(4006) } catch { /* the close handler reconnects */ }
        break
      }
      default:
        break
    }
  }

  private armReadyTimeout(): void {
    const pending = this.handshake
    if (pending === null) return
    clearTimeout(pending.timer)
    pending.timer = setTimeout(() => {
      this.settleHandshake(new Error(`QQ 网关鉴权超时（${READY_TIMEOUT_MS / 1000} 秒内未收到 READY）`))
      this.forceReconnect('QQ 网关鉴权超时，正在重连…')
    }, READY_TIMEOUT_MS)
  }

  /** op=2 IDENTIFY: subscribe intents and declare our shard. */
  private sendOp2(): void {
    this.send({
      op: 2,
      d: {
        token: `QQBot ${this.token}`,
        intents: this.intents,
        shard: [0, 1],
        properties: { $os: process.platform, $browser: 'dsh-im-gateway', $device: 'dsh-im-gateway' },
      },
    })
  }

  /** op=1 heartbeat with the last received seq (or null initially). */
  private sendOp1(): void {
    this.send({ op: 1, d: this.seq })
  }

  private send(payload: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }

  /**
   * Start the heartbeat and its ACK watchdog. The gateway answers every client
   * heartbeat with op=11; if nothing at all arrives for two intervals the socket
   * is dead even when `readyState` still says OPEN (sleep/network change without
   * a FIN), which is precisely the state that used to keep the panel green while
   * every message was lost.
   */
  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => this.sendOp1(), intervalMs)
    const grace = intervalMs * 2 + WATCHDOG_GRACE_MS
    this.watchdogTimer = setInterval(() => {
      const silentFor = Date.now() - this.lastFrameAt
      if (silentFor <= grace) return
      this.forceReconnect(`心跳无响应（${Math.round(silentFor / 1000)} 秒未收到网关任何帧），正在强制重连…`)
    }, intervalMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  // ── Event dispatch ─────────────────────────────────────────────────────────

  private dispatchEvent(type: string, d: any): void {
    switch (type) {
      case 'C2C_MESSAGE_CREATE': {
        const openid = d && d.author && d.author.id
        const text = this.extractText(d)
        if (openid && text) {
          this.recordTarget(openid, { kind: 'c2c', id: openid })
          this.rememberMsgId(openid, d)
          this.emitInbound(openid, text, openid)
        }
        break
      }
      case 'AT_MESSAGE_CREATE':
      case 'GROUP_AT_MESSAGE_CREATE': {
        const groupOpenid = d && d.group_openid
        const memberOpenid = d && d.author && d.author.member_openid
        const text = this.extractText(d)
        if (groupOpenid && text) {
          this.recordTarget(groupOpenid, { kind: 'group', id: groupOpenid })
          this.rememberMsgId(groupOpenid, d)
          this.emitInbound(groupOpenid, text, memberOpenid || groupOpenid)
        }
        break
      }
      case 'DIRECT_MESSAGE_CREATE': {
        const guildId = d && d.guild_id
        const userId = d && d.author && d.author.id
        const text = this.extractText(d)
        if (guildId && text) {
          // Guild direct messages are answered on the /dms endpoint, not the C2C
          // one — /v2/users/{guild_id}/messages would post into nowhere.
          this.recordTarget(guildId, { kind: 'dm', id: guildId })
          this.rememberMsgId(guildId, d)
          this.emitInbound(guildId, text, userId || guildId)
        }
        break
      }
      default:
        break
    }
  }

  /**
   * Store the inbound msg_id for a chat so passive replies can reference it, and
   * restart that chat's reply numbering (msg_seq is scoped to one msg_id).
   */
  private rememberMsgId(chatId: string, d: any): void {
    const id = d && d.id
    if (typeof id !== 'string' || id === '') return
    this.lastMsgId.set(chatId, id)
    this.replySeq.set(chatId, { msgId: id, seq: 0 })
  }

  /** Pull the plain-text content out of a QQ message payload. */
  private extractText(d: any): string {
    const content = d && d.content
    if (typeof content === 'string' && content.trim()) return content.trim()
    // Some events put content under `d.message` or an attachments summary.
    return ''
  }

  private recordTarget(chatId: string, target: QqTarget): void {
    this.targets.set(chatId, target)
  }

  private emitInbound(chatId: string, text: string, senderId: string | undefined): void {
    this.options.onInbound({
      chatId,
      text,
      senderId,
      runtime: {
        provider: this.options.provider,
        model: this.options.model,
        maxTokens: this.options.maxTokens,
        disposeAfterReply: this.options.disposeAfterReply,
        channel: 'qq',
      },
    })
  }

  /** Next msg_seq for this chat's current inbound msg_id. */
  private nextReplySeq(chatId: string, msgId: string): number {
    const current = this.replySeq.get(chatId)
    if (current === undefined || current.msgId !== msgId) {
      const next = { msgId, seq: 1 }
      this.replySeq.set(chatId, next)
      return next.seq
    }
    current.seq += 1
    return current.seq
  }

  /** Send a reply to the originating peer (passive response). */
  async sendText(chatId: string, text: string): Promise<void> {
    const target = this.targets.get(chatId)
    if (!target) throw new Error(`qq bot unknown reply target: ${chatId}`)
    const path = target.kind === 'group'
      ? `/v2/groups/${encodeURIComponent(target.id)}/messages`
      : target.kind === 'dm'
        ? `/dms/${encodeURIComponent(target.id)}/messages`
        : `/v2/users/${encodeURIComponent(target.id)}/messages`
    const chunks = chunkText(text)
    if (chunks.length === 0) return
    for (const chunk of chunks) {
      const msgId = this.lastMsgId.get(chatId) ?? ''
      const body: Record<string, unknown> = { msg_type: 0, content: chunk }
      if (msgId) {
        body.msg_id = msgId
        body.msg_seq = this.nextReplySeq(chatId, msgId)
      }
      try {
        await this.postMessage(path, body)
      } catch (error) {
        // The passive window is 5 minutes and allows 5 replies: an agent turn
        // that took longer than that does not have to lose its answer, so fall
        // back to one active message before giving up loudly.
        if (msgId && error instanceof QqApiError && PASSIVE_EXPIRED_CODES.has(error.code)) {
          this.options.log?.(`qq passive reply rejected (${error.code}); retrying as an active message`)
          delete body.msg_id
          delete body.msg_seq
          try {
            await this.postMessage(path, body)
            continue
          } catch (fallback) {
            const fallbackReason = fallback instanceof Error ? fallback.message : String(fallback)
            throw new Error(`${error.message}；主动消息兜底也失败：${fallbackReason}`)
          }
        }
        throw error
      }
    }
  }

  private async postMessage(path: string, body: Record<string, unknown>): Promise<void> {
    const r = await this.qqFetch(`${this.apiBase}${path}`, { method: 'POST', body })
    const failure = apiFailure(r.status, r.json, r.text)
    if (failure === null) return
    // 40054005 means the same msg_id + msg_seq already went out: the reply WAS
    // delivered, so retrying after a network blip must not be reported as a loss.
    if (failure.code === 40054005) return
    throw new QqApiError(`QQ 发送失败（err_code ${failure.code}：${describeApiCode(failure.code, failure.message)}）`, failure.code)
  }

  async stop(): Promise<void> {
    this.desiredConnected = false
    this.connected = false
    this.ready = false
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.settleHandshake(new Error('qq bot transport stopped'))
    this.closeSocket()
    this.options.onState?.('idle')
  }
}

/** A failed OpenAPI call carrying its platform error code. */
export class QqApiError extends Error {
  constructor(message: string, readonly code: number) {
    super(message)
    this.name = 'QqApiError'
  }
}

/**
 * Interpret one OpenAPI response. QQ reports failures both as an HTTP status
 * (401/403/429/500) and as a body code (`err_code` on the canonical API, `code`
 * on the legacy one) — and often with HTTP 200, so the body wins.
 * @param status - HTTP status.
 * @param json - parsed body (null when it was not JSON).
 * @param text - raw body (for the message when there is no JSON).
 * @returns the failure, or null when the call succeeded.
 */
export function apiFailure(status: number, json: any, text: string): QqApiFailure | null {
  const body = json && typeof json === 'object' ? json as Record<string, unknown> : null
  const raw = body === null ? undefined : (body.err_code ?? body.code)
  const code = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  if (Number.isFinite(code) && code !== 0) {
    return {
      code,
      message: String(body?.message ?? ''),
      fatal: FATAL_API_CODES.has(code),
    }
  }
  if (status >= 200 && status < 300) return null
  return {
    code: status,
    message: text.trim().slice(0, 160) || `HTTP ${status}`,
    fatal: status === 401 || status === 403,
  }
}
