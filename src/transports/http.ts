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
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    // The chat id ALSO rides the body (below), so the header is a convenience
    // for receivers that route on it. It may only be set when the value is
    // representable in a header: undici/`fetch` throws
    // `TypeError: Cannot convert argument to a ByteString` for any code point
    // above 0xFF, and a chat id is attacker-adjacent data (a WeChat display
    // name, a CMCC number, a webhook-supplied id). Setting it unconditionally
    // turned one non-ASCII chat into a reply that could never be delivered —
    // and the throw happened before the request was even sent.
    const header = this.options.callbackChatHeader || 'x-im-chat-id'
    if (/^[\x20-\x7E]*$/.test(chatId)) {
      headers[header] = chatId
    }
    if (this.options.callbackSecret) {
      headers['x-im-secret'] = this.options.callbackSecret
    }
    const response = await fetch(this.options.callbackUrl, {
      method: 'POST',
      headers,
      // Hard timeout so a black-holed callback cannot wedge the session.
      signal: AbortSignal.timeout(30_000),
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
