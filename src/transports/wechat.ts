import type { ChannelTransport, InboundRoute } from './types.ts'

export interface WechatClawOptions {
  /** Base URL of the clawbot companion gateway (e.g. http://127.0.0.1:9001). */
  clawUrl: string
  /** Secret token the companion requires on its API. */
  token?: string
  provider?: string
  model?: string
  maxTokens?: number
  disposeAfterReply?: boolean
  onInbound: (route: InboundRoute) => void
  log?: (msg: string) => void
  onQr?: (qrUrl: string) => void
  /** Called whenever the underlying connection state changes. */
  onState?: (status: 'connecting' | 'connected' | 'error' | 'idle', detail?: string) => void
}

/**
 * WeChat "clawbot" transport.
 *
 * Personal-WeChat accounts expose no official automation API, so a bot usually
 * runs a *companion* gateway (a desktop "claw" / wechaty-style companion). This
 * transport is a thin, dependency-free client for that companion:
 *   - it POSTs a `send` request to `{clawUrl}/send` for outbound replies;
 *   - it polls `{clawUrl}/receive` for inbound messages.
 *
 * The companion is expected to expose these two simple JSON endpoints and to
 * present a login QR at `{clawUrl}/qr` that this transport surfaces to the UI.
 * This keeps dsh-im-gateway open-source and free of any undocumented
 * reverse-engineering; the (separately run) companion owns WeChat login.
 */
export class WechatClawTransport implements ChannelTransport {
  private timer: NodeJS.Timeout | null = null
  private connected = false
  private seen = new Set<string>()

  constructor(private readonly options: WechatClawOptions) {}

  async start(): Promise<void> {
    const url = this.options.clawUrl || 'http://127.0.0.1:9001'
    if (!url) throw new Error('wechat channel requires a clawbot gateway URL')

    this.options.onState?.('connecting')

    // Probe the companion health endpoint. The clawbot companion may boot
    // lazily (or only after the user scans its QR), so a failed probe is not
    // terminal: we keep polling and report the real state as it changes.
    let healthOk = false
    try {
      const res = await this.post(`${url}/health`, this.auth())
      healthOk = res?.ok === true
    } catch {
      healthOk = false
    }
    if (healthOk) {
      this.connected = true
      this.options.log?.('wechat claw companion reachable')
      this.options.onState?.('connected')
    } else {
      this.options.log?.('wechat claw companion not reachable yet; will retry')
      this.options.onState?.('connecting', '等待 clawbot 伴生网关就绪…')
    }

    const poll = async (): Promise<void> => {
      try { await this.pollInbound(url) } catch { /* transient */ }
    }
    this.timer = setInterval(() => { void poll() }, 3000)
    void poll()

    // Surface the login QR if the companion exposes one (scan-to-login).
    try {
      const qr = await this.post(`${url}/qr`, this.auth())
      if (qr && qr.url) this.options.onQr?.(qr.url)
    } catch {
      /* no qr endpoint */
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  private auth(): Record<string, unknown> {
    return this.options.token ? { token: this.options.token } : {}
  }

  private async post(url: string, body: unknown): Promise<any> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === null || body === undefined ? '{}' : JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`claw ${url} returned ${res.status}`)
    }
    return res.json().catch(() => ({}))
  }

  private async pollInbound(url: string): Promise<void> {
    let msgs: Array<{ id?: string; from?: string; content?: string }> = []
    try {
      const res = await this.post(`${url}/receive`, this.auth())
      msgs = Array.isArray(res?.messages) ? res.messages : []
      // A successful /receive round trip means the companion is live.
      if (!this.connected) {
        this.connected = true
        this.options.onState?.('connected')
      }
    } catch {
      return
    }
    for (const msg of msgs) {
      const id = String(msg.id || '')
      const key = id || (msg.from || '') + '|' + (msg.content || '')
      if (this.seen.has(key)) continue
      this.seen.add(key)
      const text = String(msg.content || '').trim()
      if (!text || !msg.from) continue
      this.options.onInbound({
        chatId: msg.from,
        text,
        senderId: msg.from,
        runtime: {
          provider: this.options.provider,
          model: this.options.model,
          maxTokens: this.options.maxTokens,
          disposeAfterReply: this.options.disposeAfterReply,
        },
      })
    }
    // Keep the seen-set bounded.
    if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000))
  }

  /** Send a reply through the companion gateway. */
  async sendText(to: string, text: string): Promise<void> {
    await this.post(`${this.options.clawUrl}/send`, { ...this.auth(), to, text })
  }

  async stop(): Promise<void> {
    this.connected = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.options.onState?.('idle')
  }
}
