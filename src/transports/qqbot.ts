/**
 * QQ "bot" transport — official QQ Open Platform (q.qq.com) robot over the
 * WebSocket event gateway (api.sgroup.qq.com), the QQ channel's only transport.
 * Create a robot at https://q.qq.com, get its `appId` + `appSecret`, and this
 * transport handles token acquisition → gateway discovery → WebSocket
 * IDENTIFY/heartbeat → C2C/group message dispatch.
 *
 * Protocol (official, matches the OpenClaw `@openclaw/qqbot` channel & Koishi
 * `adapter-qq`):
 *   1. token   POST https://bots.qq.com/app/getAppAccessToken
 *              body { appId, clientSecret } -> { access_token, expires_in (7200s) }
 *   2. gateway GET {apiBase}/gateway, header `Authorization: QQBot <token>`
 *              -> { url: wss://... }
 *   3. WS      connect with headers Authentication + X-Union-Appid.
 *              - op=10 Hello -> send op=2 IDENTIFY { d:{ token, intents, shard:[0,1] } }
 *              - op=1 heartbeat every heartbeat_interval, payload d = last seq
 *              - op=0 Dispatch: C2C_MESSAGE_CREATE (1<<25), AT_MESSAGE_CREATE (1<<30),
 *                GROUP_AT_MESSAGE_CREATE, DIRECT_MESSAGE_CREATE (1<<12)
 *   4. send    C2C  POST {apiBase}/v2/users/{openid}/messages
 *              group POST {apiBase}/v2/groups/{group_openid}/messages  (needs msg_id)
 *
 * Chat identity: the external `openid` (per-bot opaque user id) is used as the
 * chatId for session keying, exactly like the other channels. Outbound replies
 * must be *passive* (carry the inbound msg_id) for C2C / group — matching the
 * gateway's rules.
 *
 * > Limits: group/C2C robot capabilities must be granted on q.qq.com (提审);
 * > before approval the API returns permission errors — that is expected.
 * > C2C/group sending is passive-response only (no proactive push).
 */

import WebSocket from 'ws'
import type { ChannelTransport, InboundRoute } from './types.ts'

/** Official token endpoint. */
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
/** Production api base (sandbox: https://sandbox.api.sgroup.qq.com). */
export const DEFAULT_QQ_API_BASE = 'https://api.sgroup.qq.com'
/** WS connect/open timeout. */
const CONNECT_TIMEOUT_MS = 20000
/** HTTP timeout for token / gateway / send calls. */
const HTTP_TIMEOUT_MS = 15000
/** Reconnect backoff bounds (exponential). */
const BASE_RECONNECT_MS = 3000
const MAX_RECONNECT_MS = 60000

/** Identifies the sender/peer kind of an inbound message. */
type PeerKind = 'c2c' | 'group'

export interface QQBotOptions {
  appId: string
  clientSecret: string
  /** Api base (defaults to https://api.sgroup.qq.com; sandbox override supported). */
  apiBase?: string
  /** sandbox=true uses https://sandbox.api.sgroup.qq.com. */
  sandbox?: boolean
  provider?: string
  model?: string
  maxTokens?: number
  disposeAfterReply?: boolean
  onInbound: (route: InboundRoute) => void
  log?: (msg: string) => void
  /** Connection state callback. */
  onState?: (status: 'connecting' | 'connected' | 'error' | 'idle', detail?: string) => void
}

/** Pending send for one peer, keyed by external id + kind. */
interface QqTarget {
  kind: PeerKind
  id: string
}

/**
 * Official QQ bot transport. Owns token cache, gateway discovery, the
 * WebSocket event loop (IDENTIFY + heartbeat + resume-on-reconnect) and
 * C2C/group message dispatch, routing every inbound message through the
 * gateway and sending agent replies back via the REST send endpoints.
 */
export class QQBotTransport implements ChannelTransport {
  private ws: WebSocket | null = null
  private connected = false
  private token = ''
  private tokenExpiresAt = 0
  private seq: number | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private desiredConnected = false
  private ready = false
  /** External id -> peer kind map used for reply routing. */
  private readonly targets = new Map<string, QqTarget>()
  /** External id -> last inbound msg_id (required for passive group/C2C replies). */
  private readonly lastMsgId = new Map<string, string>()

  constructor(private readonly options: QQBotOptions) {}

  get apiBase(): string {
    if (this.options.sandbox) return 'https://sandbox.api.sgroup.qq.com'
    return (this.options.apiBase || DEFAULT_QQ_API_BASE).replace(/\/+$/, '')
  }

  async start(): Promise<void> {
    if (this.desiredConnected) return
    this.desiredConnected = true
    this.options.onState?.('connecting')
    await this.connect()
  }

  isConnected(): boolean {
    return this.connected
  }

  // ── HTTP helpers ───────────────────────────────────────────────────────────

  /** Fetch a fresh QQ bot access_token (cached until near expiry). */
  private async getToken(): Promise<string> {
    const now = Date.now()
    if (this.token && this.tokenExpiresAt > now + 60_000) return this.token
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.options.appId, clientSecret: this.options.clientSecret }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    if (!resp.ok) throw new Error(`qq bot token http ${resp.status}`)
    const json: any = await resp.json()
    const token = json && json.access_token
    if (!token) throw new Error('qq bot token missing in response')
    this.token = token
    const expiresIn = Number(json.expires_in) || 7200
    this.tokenExpiresAt = Date.now() + expiresIn * 1000
    return token
  }

  private async qqFetch(
    url: string,
    opts: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; json: any; text: string }> {
    const token = await this.getToken()
    const resp = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json',
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    const text = await resp.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* non-json */ }
    return { status: resp.status, json, text }
  }

  // ── WebSocket lifecycle ────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    try {
      const token = await this.getToken()
      const gwResp = await this.qqFetch(`${this.apiBase}/gateway`)
      // QQ API wraps results as { code, message, data }; some deployments return
      // the url at the top level. Handle both.
      const json = gwResp.json || {}
      const dataUrl = (json.data && json.data.url) || json.url
      const gatewayUrl = typeof dataUrl === 'string' ? dataUrl : ''
      if (!gatewayUrl) throw new Error('qq bot gateway url missing')
      await this.openSocket(gatewayUrl, token, gwResp.status)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.options.onState?.('error', message)
      this.options.log?.(`qq bot connect failed: ${message}`)
      // Bad credentials / permission errors won't fix themselves by retrying
      // immediately, but transient network errors should be retried.
      if (this.desiredConnected) this.scheduleReconnect()
    }
  }

  private openSocket(gatewayUrl: string, token: string, _httpStatus: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (error: Error): void => { if (!settled) { settled = true; reject(error) } }

      let ws: WebSocket
      try {
        ws = new WebSocket(gatewayUrl, {
          headers: {
            Authorization: `QQBot ${token}`,
            'X-Union-Appid': this.options.appId,
          },
        })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        return
      }
      this.ws = ws

      const openTimer = setTimeout(() => {
        if (!settled && ws.readyState !== WebSocket.OPEN) {
          try { ws.close() } catch { /* ignore */ }
          fail(new Error('qq bot websocket connect timeout'))
        }
      }, CONNECT_TIMEOUT_MS)

      ws.on('open', () => {
        clearTimeout(openTimer)
        this.options.log?.('qq bot websocket open')
        // Connection established; IDENTIFY follows on the first Hello. The
        // transport is only reported "connected" once the gateway sends a
        // Dispatch (READY) frame, which the handleFrame listener does.
        if (!settled) { settled = true; resolve() }
      })
      ws.on('message', (data) => {
        this.handleFrame(String(data))
      })
      ws.on('close', (code, reason) => {
        clearTimeout(openTimer)
        this.connected = false
        this.ready = false
        this.stopHeartbeat()
        if (!settled) fail(new Error(`qq bot websocket closed before ready (code=${code})`))
        this.options.log?.(`qq bot websocket closed (code=${code} reason=${reason.toString()})`)
        this.scheduleReconnect()
      })
      ws.on('error', (error) => {
        this.options.log?.(`qq bot websocket error: ${error.message}`)
        if (!settled) { clearTimeout(openTimer); fail(error) }
      })
    })
  }

  private scheduleReconnect(): void {
    if (!this.desiredConnected || this.reconnectTimer) return
    this.reconnectAttempts++
    const delay = Math.min(
      BASE_RECONNECT_MS * Math.pow(2, this.reconnectAttempts - 1),
      MAX_RECONNECT_MS,
    )
    this.options.onState?.('connecting', 'QQ bot 网关重连中…')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.options.log?.(`qq bot reconnect attempt ${this.reconnectAttempts}`)
      void this.connect().catch(() => {})
    }, delay)
  }

  private handleFrame(raw: string): void {
    let frame: any
    try { frame = JSON.parse(raw) } catch { return }
    if (!frame || typeof frame !== 'object') return
    const op = frame.op
    switch (op) {
      case 10: { // Hello
        const d = frame.d || {}
        this.sendOp2()
        this.startHeartbeat(Number(d.heartbeat_interval) || 41250)
        break
      }
      case 0: { // Dispatch
        if (typeof frame.s === 'number') this.seq = frame.s
        this.ready = true
        if (!this.connected) {
          this.connected = true
          this.reconnectAttempts = 0
          this.options.onState?.('connected')
        }
        this.dispatchEvent(frame.t, frame.d || {})
        break
      }
      case 1: {
        this.sendOp1()
        break
      }
      case 7: { // Reconnect
        this.options.log?.('qq bot gateway requested reconnect (op=7)')
        try { this.ws?.close() } catch { /* ignore */ }
        break
      }
      default:
        break
    }
  }

  /** op=2 IDENTIFY: subscribe intents and declare our shard. */
  private sendOp2(): void {
    const intents = (1 << 25) | (1 << 30) | (1 << 12) // GROUP_AND_C2C | AT_MESSAGES | DIRECT_MESSAGE
    this.send({ op: 2, d: { token: `QQBot ${this.token}`, intents, shard: [0, 1] } })
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

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => this.sendOp1(), intervalMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
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
          this.recordTarget(guildId, { kind: 'c2c', id: guildId })
          this.rememberMsgId(guildId, d)
          this.emitInbound(guildId, text, userId || guildId)
        }
        break
      }
      default:
        break
    }
  }

  /** Store the inbound msg_id for a chat so passive replies can reference it. */
  private rememberMsgId(chatId: string, d: any): void {
    const id = d && d.id
    if (typeof id === 'string' && id) this.lastMsgId.set(chatId, id)
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

  /** Send a reply to the originating peer (passive response). */
  async sendText(chatId: string, text: string): Promise<void> {
    const target = this.targets.get(chatId)
    if (!target) throw new Error(`qq bot unknown reply target: ${chatId}`)
    if (target.kind === 'group') {
      // Group messages are passive-response only.
      await this.qqFetch(`${this.apiBase}/v2/groups/${encodeURIComponent(target.id)}/messages`, {
        method: 'POST',
        body: { msg_type: 0, content: text, msg_id: this.lastMsgId.get(chatId) || '' },
      })
    } else {
      await this.qqFetch(`${this.apiBase}/v2/users/${encodeURIComponent(target.id)}/messages`, {
        method: 'POST',
        body: { msg_type: 0, content: text, msg_id: this.lastMsgId.get(chatId) || '' },
      })
    }
  }

  async stop(): Promise<void> {
    this.desiredConnected = false
    this.connected = false
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.removeAllListeners()
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
    this.options.onState?.('idle')
  }
}
