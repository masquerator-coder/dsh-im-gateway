import type { ChannelTransport, InboundRoute } from './types.ts'

export interface QQChannelOptions {
  /** Optional QQ number for password login. Leave empty for QR login. */
  qq?: string
  /** Optional password (QR login is preferred). */
  password?: string
  provider?: string
  model?: string
  maxTokens?: number
  disposeAfterReply?: boolean
  onInbound: (route: InboundRoute) => void
  log?: (msg: string) => void
  /** Called with a QR data-URL (PNG) so the client can render it for scanning. */
  onQr?: (dataUrl: string) => void
  /** Connection state callback. */
  onState?: (status: 'connected' | 'connecting' | 'error' | 'idle', detail?: string) => void
}

/**
 * QQ bot transport driven by `icqq` (the maintained oicq fork). Login prefers a
 * QR scan — the "傻瓜式" path: with no stored qq/password, `client.login()` puts
 * icqq in QR mode and we forward the QR PNG to the UI. Replies are sent via
 * `pickGroup`/`pickFriend` depending on the originating chat.
 */
export class QQTransport implements ChannelTransport {
  private client: any = null
  private connected = false
  /** chatId -> { kind: 'group'|'friend', id: number } for reply routing. */
  private targets = new Map<string, { kind: 'group' | 'friend'; id: number }>()

  constructor(private readonly options: QQChannelOptions) {}

  async start(): Promise<void> {
    const icqq = await import('icqq')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { createClient } = icqq as any

    // No uin at construction: login() with args sets the account.
    const client = createClient()
    this.client = client

    client.on('system.online', () => {
      this.connected = true
      this.options.onState?.('connected')
    })
    client.on('system.login.slider', () => {
      this.options.onState?.('connecting', '需要滑块验证')
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.on('system.login.qrcode', (event: any) => {
      const image = event?.image
      if (image && typeof image !== 'string') {
        const dataUrl = `data:image/png;base64,${Buffer.from(image).toString('base64')}`
        this.options.onQr?.(dataUrl)
      } else {
        this.options.onQr?.(String(image || ''))
      }
    })
    client.on('message', (msg: any) => this.onMessage(msg))

    this.options.onState?.('connecting')
    try {
      if (this.options.qq && this.options.password) {
        await client.login(Number(this.options.qq), this.options.password)
      } else {
        // No stored credential: QR login.
        await client.login()
      }
    } catch (error) {
      this.options.onState?.('error', error instanceof Error ? error.message : String(error))
      this.options.log?.(`qq login error: ${String(error)}`)
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  private onMessage(msg: any): void {
    const text = String(msg?.raw_message || msg?.message || '')
    if (!text) return
    const gid = msg?.group_id
    const uid = msg?.user_id
    if (gid) {
      const chatId = String(gid)
      this.targets.set(chatId, { kind: 'group', id: Number(gid) })
      this.options.onInbound({
        chatId,
        text,
        senderId: uid !== undefined ? String(uid) : undefined,
        runtime: {
          provider: this.options.provider,
          model: this.options.model,
          maxTokens: this.options.maxTokens,
          disposeAfterReply: this.options.disposeAfterReply,
          channel: 'qq',
        },
      })
    } else if (uid) {
      const chatId = String(uid)
      this.targets.set(chatId, { kind: 'friend', id: Number(uid) })
      this.options.onInbound({
        chatId,
        text,
        senderId: String(uid),
        runtime: {
          provider: this.options.provider,
          model: this.options.model,
          maxTokens: this.options.maxTokens,
          disposeAfterReply: this.options.disposeAfterReply,
          channel: 'qq',
        },
      })
    }
  }

  /** Send a reply to the originating chat (group or private). */
  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.client) throw new Error('qq channel not started')
    const target = this.targets.get(chatId)
    if (target) {
      if (target.kind === 'group') {
        await this.client.pickGroup(target.id).sendMsg(text)
      } else {
        await this.client.pickFriend(target.id).sendMsg(text)
      }
    } else {
      await this.client.pickFriend(Number(chatId)).sendMsg(text)
    }
  }

  async stop(): Promise<void> {
    try { await this.client?.logout?.() } catch { /* ignore */ }
    this.client = null
    this.connected = false
    this.targets.clear()
    this.options.onState?.('idle')
  }
}
