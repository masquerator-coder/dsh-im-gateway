/**
 * WeChat "ilink" transport — direct client of Tencent's official ilink bot
 * gateway (https://ilinkai.weixin.qq.com), ported from the reference
 * `dsh-clawbot` plugin design.
 *
 * Unlike the earlier "clawbot companion gateway" sketch, this transport talks
 * to the ilink HTTPS API **directly** — no separate local companion process is
 * required. The life cycle is:
 *
 *   1. QR bind — `POST /ilink/bot/get_bot_qrcode?bot_type=3` returns a login QR
 *      (`qrcode_img_content`, surfaced to the UI via `onQr`). While unbound we
 *      poll `POST /ilink/bot/get_qrcode_status?qrcode=<key>` until `confirmed`,
 *      which yields the `bot_token`, `ilink_bot_id`, `baseurl`, `ilink_user_id`.
 *   2. Unlock — after binding, the bound WeChat account must send the bot **one
 *      message** so the gateway issues a `context_token`; we learn it by polling
 *      `getupdates`.
 *   3. Steady state — we poll `getupdates` (~1.5s) for inbound text/voice from
 *      the bound user and post outbound replies to `sendmessage`.
 *
 * Binding state (token / baseUrl / scannedUser / contextToken / cursor) is
 * persisted per channel under `~/.dsh/im-workspace/wechat-state/<key>.json`
 * (mirroring the email cursor pattern), so a restart never forces a re-bind.
 *
 * > Limits (same as the reference): the gateway rate-limits outbound sending
 * > heavily — this is a notification / decision channel, not a chat tool. The
 * > `context_token` only appears after the bound user sends one message first.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import type { ChannelTransport, InboundRoute } from './types.ts'

/** Default ilink gateway (Tencent official bot gateway). */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
/** channel_version the ilink API expects (matches the reference clawbot). */
const CHANNEL_VERSION = 'clawbot/1.0'
/** Bot type requested at bind (3 = WeChat bot). */
const BOT_TYPE = 3

/** Inbound getupdates poll cadence (from end of one poll to the next). */
const POLL_INTERVAL_MS = 1500
/** Per-request timeout for ilink HTTP calls. */
const HTTP_TIMEOUT_MS = 20000

/** Per-channel persisted binding state file name (mirror email state pattern). */
function stateFileFor(channelId: string): string {
  const key = Buffer.from(channelId).toString('hex').slice(0, 40) || 'default'
  return join(homedir(), '.dsh', 'im-workspace', 'wechat-state', `${key}.json`)
}

/** Durable per-channel binding state, persisted across restarts. */
interface WechatState {
  /** The ilink bot_token (from bind confirmation / config override). */
  token: string
  /** The resolved ilink gateway base URL. */
  baseUrl: string
  /** ilink bot id (informational). */
  botId: string
  /** The bound WeChat user id (the only chat this bot talks to). */
  scannedUser: string
  /** Send credential; only present after the bound user sends one message. */
  contextToken: string
  /** getupdates pagination cursor (empty until first successful poll). */
  cursor: string
  /** Last meaningful error string, surfaced to the UI. */
  lastError: string
}

function emptyState(baseUrl: string): WechatState {
  return { token: '', baseUrl, botId: '', scannedUser: '', contextToken: '', cursor: '', lastError: '' }
}

export interface WechatIlinkOptions {
  /** Channel id — used to key the persisted binding-state file. */
  channelId: string
  /** ilink gateway base URL (defaults to `https://ilinkai.weixin.qq.com`). */
  baseUrl?: string
  /** Optional pre-seeded ilink bot_token (from the channel's secret field). */
  token?: string
  provider?: string
  model?: string
  maxTokens?: number
  disposeAfterReply?: boolean
  onInbound: (route: InboundRoute) => void
  log?: (msg: string) => void
  /** Called with the login QR image URL so the client can render a bind QR. */
  onQr?: (qrUrl: string) => void
  /** Called whenever the underlying connection state changes. */
  onState?: (status: 'connecting' | 'connected' | 'error' | 'idle', detail?: string) => void
}

/**
 * Direct ilink-gateway WeChat transport. Owns the QR-bind → unlock → poll
 * lifecycle in-process and persists binding state per channel.
 */
export class WechatIlinkTransport implements ChannelTransport {
  private state: WechatState
  private readonly stateFile: string
  private timer: NodeJS.Timeout | null = null
  private started = false
  private connected = false
  /** Login QR state while binding. */
  private qrKey = ''
  private qrUrl = ''
  private qrWaiting = false

  constructor(private readonly options: WechatIlinkOptions) {
    const base = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.stateFile = stateFileFor(options.channelId)
    this.state = emptyState(base)
    if (options.token) this.state.token = options.token
    this.state.baseUrl = base
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    await this.loadState()
    if (this.options.token && !this.state.token) {
      this.state.token = this.options.token
      await this.saveState().catch(() => {})
    }

    if (!this.state.token) {
      // Unbound — start a QR bind.
      this.options.onState?.('connecting', '未绑定：请扫码绑定微信')
      await this.requestQr()
    }

    const poll = async (): Promise<void> => {
      try { await this.pollOnce() } catch { /* transient */ }
      if (!this.started) return
      this.timer = setTimeout(() => { void poll() }, POLL_INTERVAL_MS)
    }
    void poll()
  }

  isConnected(): boolean {
    return this.connected
  }

  // ── state persistence ──────────────────────────────────────────────────────

  private async loadState(): Promise<void> {
    try {
      const raw = await readFile(this.stateFile, 'utf8')
      const p = JSON.parse(raw)
      if (p && typeof p === 'object') {
        this.state = { ...emptyState(this.state.baseUrl), ...p, baseUrl: p.baseUrl || this.state.baseUrl }
      }
    } catch { /* no persisted state yet */ }
  }

  private async saveState(): Promise<void> {
    try {
      await mkdir(join(homedir(), '.dsh', 'im-workspace', 'wechat-state'), { recursive: true })
      await writeFile(this.stateFile, JSON.stringify(this.state), 'utf8')
    } catch (error) {
      this.options.log?.(`wechat state persist failed: ${String(error)}`)
    }
  }

  // ── ilink HTTP helpers ─────────────────────────────────────────────────────

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomUin(),
    }
    if (this.state.token) h.Authorization = `Bearer ${this.state.token}`
    return h
  }

  private async httpJson(
    url: string,
    opts: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<{ status: number; text: string; json: any }> {
    const { method = 'GET', body, timeoutMs = HTTP_TIMEOUT_MS } = opts
    const resp = await fetch(url, {
      method,
      headers: this.authHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await resp.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    return { status: resp.status, text, json }
  }

  private async requestQr(): Promise<void> {
    try {
      const r = await this.httpJson(`${this.state.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, { timeoutMs: 25000 })
      const qr = r.json && r.json.qrcode
      if (!qr) {
        this.options.onState?.('connecting', '获取二维码失败')
        return
      }
      this.qrKey = String(qr)
      this.qrUrl = String((r.json && r.json.qrcode_img_content) || '').trim()
      this.qrWaiting = true
      this.options.onQr?.(this.qrUrl)
    } catch (error) {
      this.options.log?.(`wechat requestQr failed: ${String(error)}`)
    }
  }

  private async pollQrStatus(): Promise<void> {
    if (!this.qrKey) return
    try {
      const r = await this.httpJson(
        `${this.state.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(this.qrKey)}`,
        { timeoutMs: 25000 },
      )
      const status = r.json && r.json.status
      if (status === 'confirmed') {
        const token = String((r.json && r.json.bot_token) || '').trim()
        if (token) {
          this.state.token = token
          this.state.botId = String((r.json && r.json.ilink_bot_id) || '').trim()
          this.state.baseUrl = String((r.json && r.json.baseurl) || '').trim() || this.state.baseUrl
          this.state.scannedUser = String((r.json && r.json.ilink_user_id) || '').trim()
          this.state.contextToken = ''
          this.state.cursor = ''
          this.state.lastError = ''
          this.qrKey = ''
          this.qrWaiting = false
          this.connected = false // not yet — needs the unlock message
          await this.saveState().catch(() => {})
          this.options.onState?.('connecting', '已绑定：请在微信里给机器人发一条消息解锁发送')
          this.options.log?.('wechat bound: ' + this.state.botId)
          return
        }
      } else if (status === 'expired') {
        this.qrWaiting = false
        this.options.onState?.('connecting', '二维码已过期，请刷新')
        await this.requestQr()
        return
      }
    } catch (error) {
      this.options.log?.(`wechat pollQrStatus failed: ${String(error)}`)
    }
  }

  /** Extract inbound text from an ilink message (item_list). */
  private extractText(m: any): string {
    const items = Array.isArray(m && m.item_list) ? m.item_list : []
    const parts: string[] = []
    for (const it of items) {
      if (!it) continue
      if (it.type === 1 && it.text_item && typeof it.text_item.text === 'string') parts.push(it.text_item.text)
      else if (it.type === 3 && it.voice_item && typeof it.voice_item.text === 'string' && it.voice_item.text) parts.push(it.voice_item.text)
    }
    return parts.join('\n').trim()
  }

  private async pollInbound(): Promise<void> {
    if (!this.state.token) return
    const r = await this.httpJson(
      `${this.state.baseUrl}/ilink/bot/getupdates`,
      {
        method: 'POST',
        body: {
          get_updates_buf: this.state.cursor,
          base_info: { channel_version: CHANNEL_VERSION },
        },
        timeoutMs: 20000,
      },
    )
    if (r.status !== 200 || !r.json) return
    const j = r.json
    if (j.get_updates_buf) this.state.cursor = j.get_updates_buf

    // Treat an active getupdates round-trip as "connected" to the gateway.
    if (!this.connected) {
      const errcode = j.errcode ?? 0
      if (errcode === -14) {
        // Credentials/session dead → back to unbound.
        this.connected = false
        this.state.lastError = '微信连接断线：会话已失效，请重新扫码绑定'
        this.options.onState?.('error', this.state.lastError)
        return
      }
      this.connected = true
      this.options.onState?.('connected')
      if (this.state.lastError) { this.state.lastError = ''; await this.saveState().catch(() => {}) }
    }

    const msgs: any[] = Array.isArray(j.msgs) ? j.msgs : []
    const confirmedIds = new Set<string>()
    const incoming: Array<{ from: string; text: string }> = []
    for (const m of msgs) {
      const from = String((m && m.from_user_id) || '').trim()
      const ct = String((m && m.context_token) || '').trim()
      if (ct && from && from === this.state.scannedUser) {
        this.state.contextToken = ct
        confirmedIds.add(ct)
      }
      // Only the bound user's text/voice messages count; skip the bot's own.
      const mtype = (m && m.message_type) || 1
      if (mtype === 2) continue
      if (!from || from.endsWith('@im.bot')) continue
      if (from !== this.state.scannedUser) continue
      const text = this.extractText(m)
      if (text) incoming.push({ from, text })
    }
    if (confirmedIds.size || incoming.length) await this.saveState().catch(() => {})
    for (const it of incoming) {
      this.options.onInbound({
        chatId: it.from,
        text: it.text,
        senderId: it.from,
        runtime: {
          provider: this.options.provider,
          model: this.options.model,
          maxTokens: this.options.maxTokens,
          disposeAfterReply: this.options.disposeAfterReply,
          channel: 'wechat',
        },
      })
    }
  }

  private async pollOnce(): Promise<void> {
    try {
      if (this.qrWaiting) {
        await this.pollQrStatus()
        return
      }
      if (this.state.token) await this.pollInbound()
    } catch (error) {
      this.options.log?.(`wechat poll failed: ${String(error)}`)
    }
  }

  /** Send a reply to the bound user through the ilink gateway. */
  async sendText(to: string, text: string): Promise<void> {
    if (!this.state.token) throw new Error('wechat channel not bound')
    if (!to) throw new Error('wechat send target missing')
    if (!this.state.contextToken) {
      throw new Error('缺少发送凭证（context_token）：请先在微信里给机器人发一条消息')
    }
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: `wct-${randomBytes(6).toString('hex')}`,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: this.state.contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    }
    const r = await this.httpJson(`${this.state.baseUrl}/ilink/bot/sendmessage`, { method: 'POST', body, timeoutMs: 20000 })
    const parsed = r.json
    let ok = false
    if (parsed && typeof parsed.ret === 'number') ok = parsed.ret === 0
    else if (parsed && typeof parsed.errcode === 'number') ok = parsed.errcode === 0
    else ok = r.status === 200 && !parsed.errmsg
    if (!ok) {
      // A stale send credential → drop it so the next getupdates can refresh it.
      const em = String(parsed && (parsed.errmsg || parsed.error) || '')
      if (parsed && (parsed.ret === -2 || em.toLowerCase().indexOf('prepare failed') >= 0)) {
        this.state.contextToken = ''
        this.state.lastError = '微信连接断线：发送凭证已过期，请在微信里给机器人再发一条消息'
        await this.saveState().catch(() => {})
      }
      throw new Error(`wechat send failed: ret=${parsed && parsed.ret} errmsg=${em || r.status}`)
    }
  }

  async stop(): Promise<void> {
    this.started = false
    this.connected = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.options.onState?.('idle')
  }
}

function randomUin(): string {
  const n = Math.floor(Math.random() * 0xffffffff) >>> 0
  return Buffer.from(String(n)).toString('base64')
}
