import type { ChannelTransport, InboundRoute } from './types.ts'

export interface FeishuChannelOptions {
  appId: string
  appSecret: string
  provider?: string
  model?: string
  maxTokens?: number
  disposeAfterReply?: boolean
  onInbound: (route: InboundRoute) => void
  log?: (msg: string) => void
  /** Called with a change to the connection state. */
  onState?: (status: 'connected' | 'error' | 'connecting' | 'idle', detail?: string) => void
}

/**
 * Feishu / Lark bot transport using the official long-connection (WebSocket)
 * event service, so no public HTTPS URL is required. Sending uses the tenant
 * access token. The "傻瓜式" config only asks for `appId` + `appSecret` from
 * Feishu's open platform.
 */
export class FeishuTransport implements ChannelTransport {
  private wsClient: any = null
  private larkClient: any = null
  private connected = false

  constructor(private readonly options: FeishuChannelOptions) {}

  async start(): Promise<void> {
    const { appId, appSecret } = this.options
    if (!appId || !appSecret) {
      if (this.options.onState) this.options.onState('error', 'missing appId/appSecret')
      throw new Error('feishu channel requires appId and appSecret')
    }

    // Lazy-require the SDK so other channels never break if it is missing.
    const lark = await import('@larksuiteoapi/node-sdk')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Client, EventDispatcher, WSClient } = lark as any

    this.larkClient = new Client({ appId, appSecret })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispatcher = new EventDispatcher({ loggerLevel: 'warn' }).register({
      'im.message.receive_v1': (data: any) => {
        try { this.onReceive(data) } catch (e) { this.options.log?.(`feishu receive error: ${String(e)}`) }
      },
    })

    this.wsClient = new WSClient({
      appId,
      appSecret,
      loggerLevel: 'warn',
      onReady: () => {
        this.connected = true
        this.options.onState?.('connected')
      },
      onReconnecting: () => {
        if (this.options.onState) this.options.onState('connecting', 'reconnecting…')
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onError: (err: any) => {
        this.options.onState?.('error', err instanceof Error ? err.message : String(err))
      },
    })

    this.options.onState?.('connecting')
    try {
      await this.wsClient.start({ eventDispatcher: dispatcher })
    } catch (error) {
      this.options.onState?.('error', error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  private onReceive(data: any): void {
    const message = data?.message
    if (!message) return
    const msgType = message.message_type
    if (msgType !== 'text') return
    const text = this.extractText(message)
    if (!text) return
    const chatId = message.chat_id || message.message_id || ''
    const senderId = data?.sender?.sender_id?.open_id
      || data?.sender?.sender_id?.user_id || ''
    if (!chatId) return
    this.options.onInbound({
      chatId,
      text,
      senderId: senderId || undefined,
      runtime: {
        provider: this.options.provider,
        model: this.options.model,
        maxTokens: this.options.maxTokens,
        disposeAfterReply: this.options.disposeAfterReply,
      },
    })
  }

  private extractText(message: any): string {
    try {
      const content = JSON.parse(message.content || '{}')
      return String(content.text || '').trim()
    } catch {
      return ''
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  /** Send a text message into a chat. */
  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.larkClient) throw new Error('feishu channel not started')
    await this.larkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    })
  }

  async stop(): Promise<void> {
    try { await this.wsClient?.close?.() } catch { /* ignore */ }
    this.wsClient = null
    this.larkClient = null
    this.connected = false
    this.options.onState?.('idle')
  }
}
