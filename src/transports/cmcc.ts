import type { ChannelTransport } from './types.ts' // not used directly here

import { SmsClient, type InboundMessage } from './cmcc/smsClient.ts'

export const DEFAULT_SERVER_URL = 'wss://5gvas01.cmicmaap.com/gtw-ai/openclaw/ws/msg'

export interface CmccTransportOptions {
  apiKey: string
  serverUrl?: string
  uploadUrl?: string
  version?: string
  provider?: string
  model?: string
  maxTokens?: number
  disposeAfterReply?: boolean
  onInbound: (route: {
    chatId: string
    text: string
    media?: { mediaType?: string; mediaUrl?: string; mediaFileName?: string }
    runtime?: {
      provider?: string
      model?: string
      maxTokens?: number
      disposeAfterReply?: boolean
    }
  }) => void
  /** Called whenever the underlying connection state changes. */
  onState?: (status: 'connecting' | 'connected' | 'error' | 'idle', detail?: string) => void
}

/**
 * CMCC (5G消息) transport. Owns one SmsClient WebSocket connection and routes
 * inbound 5G messages into the gateway, and sends agent replies back over the
 * same socket. Media messages are passed through with their remote URL; richer
 * media handling can be added behind the `media` field.
 */
export class CmccTransport implements ChannelTransport {
  private client: SmsClient | null = null
  private desiredConnected = false

  constructor(private readonly options: CmccTransportOptions) {}

  async start(): Promise<void> {
    this.desiredConnected = true
    const serverUrl = this.options.serverUrl || DEFAULT_SERVER_URL
    const version = this.options.version || '2.0'
    const client = new SmsClient(this.options.apiKey, serverUrl, version)
    this.client = client
    this.options.onState?.('connecting')

    client.on('message', (msg: InboundMessage) => this.onMessage(msg))
    client.on('connected', () => {
      this.options.onState?.('connected')
    })
    client.on('error', (error: Error) => {
      this.options.onState?.('error', error.message)
    })
    client.on('reconnecting', () => {
      if (this.desiredConnected) this.options.onState?.('connecting', 'reconnecting…')
    })
    client.on('disconnected', () => {
      if (this.desiredConnected) this.options.onState?.('connecting', 'reconnecting…')
    })

    try {
      await client.connect()
    } catch (error) {
      // SmsClient auto-reconnects on close; surface the transient failure.
      this.options.onState?.('error', error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  isConnected(): boolean {
    return this.client?.isConnected() ?? false
  }

  private onMessage(msg: InboundMessage): void {
    let text = (msg.content || '').trim()
    if (msg.mediaType === 'IMAGE' && msg.mediaUrl) {
      text += `\n\n[系统通知] 用户发送了图片\n${msg.mediaUrl}`
    } else if (msg.mediaType && msg.mediaUrl) {
      text += `\n\n[系统通知] 用户发送了${msg.mediaType}文件\n${msg.mediaUrl}`
    }
    this.options.onInbound({
      chatId: msg.from,
      text: text || msg.content || '',
      media: msg.mediaUrl
        ? { mediaType: msg.mediaType, mediaUrl: msg.mediaUrl, mediaFileName: msg.mediaFileName }
        : undefined,
      runtime: {
        provider: this.options.provider,
        model: this.options.model,
        maxTokens: this.options.maxTokens,
        disposeAfterReply: this.options.disposeAfterReply,
      },
    })
  }

  /** Send a reply back to a phone number over the 5G channel. */
  async sendText(to: string, content: string): Promise<void> {
    const client = this.client
    if (!client || !client.isConnected()) {
      throw new Error('cmcc channel not connected')
    }
    await client.sendText(to, content)
  }

  async stop(): Promise<void> {
    this.desiredConnected = false
    const client = this.client
    this.client = null
    if (client) {
      client.removeAllListeners()
      client.disconnect()
    }
    this.options.onState?.('idle')
  }
}
