import type { InboundHttpServer } from '../inbound.ts'
import type { ChannelTransport, InboundRoute } from './types.ts'

export interface HttpChannelOptions {
  path: string
  secret: string
  chatIdField: string
  textField: string
  senderField?: string
  callbackUrl: string
  callbackChatHeader?: string
  callbackSecret?: string
  provider?: string
  model?: string
  maxTokens?: number
  disposeAfterReply?: boolean
  onInbound: (route: InboundRoute) => void
}

/**
 * HTTP webhook transport for a single `http` channel: registers a URL path on
 * the shared inbound server; replies are POSTed back to the channel's
 * `callbackUrl` (matching the original im-gateway webhook behaviour).
 */
export class HttpTransport implements ChannelTransport {
  private readonly path: string
  private started = false

  constructor(
    private readonly server: InboundHttpServer,
    private readonly options: HttpChannelOptions,
  ) {
    this.path = options.path
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.server.register({
      path: this.path,
      secret: this.options.secret,
      chatIdField: this.options.chatIdField,
      textField: this.options.textField,
      senderField: this.options.senderField,
      onMessage: (message) => this.onInbound(message),
    })
  }

  isConnected(): boolean {
    return this.started
  }

  private async onInbound(message: { chatId: string; text: string; senderId?: string }): Promise<undefined> {
    this.options.onInbound({
      chatId: message.chatId,
      text: message.text,
      senderId: message.senderId,
      runtime: {
        provider: this.options.provider,
        model: this.options.model,
        maxTokens: this.options.maxTokens,
        disposeAfterReply: this.options.disposeAfterReply,
        channel: 'http',
      },
    })
    return undefined
  }

  /** POST one reply back to the configured callback URL (ChatIo.sendText). */
  async sendText(chatId: string, text: string): Promise<void> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [this.options.callbackChatHeader || 'x-im-chat-id']: chatId,
    }
    if (this.options.callbackSecret) {
      headers['x-im-secret'] = this.options.callbackSecret
    }
    const response = await fetch(this.options.callbackUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chat_id: chatId, text, ts: Date.now() }),
    })
    if (!response.ok) {
      throw new Error(`http callback returned ${response.status} ${response.statusText}`)
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    this.server.unregister(this.path)
  }
}
