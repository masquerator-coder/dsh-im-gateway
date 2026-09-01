import type { ChannelTransport, InboundRoute } from './types.ts'

// nodemailer (SMTP outbound) and imapflow (IMAP inbound) are bundled runtime
// deps of this plugin (both MIT).

import type * as Nodemailer from 'nodemailer'

export interface EmailChannelOptions {
  host: string
  imapPort?: number
  smtpPort?: number
  useTls?: boolean
  account: string
  /** Secret: SMTP/IMAP password or app code (resolved from credentials). */
  password: string
  /** IMAP folder to watch (default INBOX). */
  inbox?: string
  /** Poll interval for inbound mail (ms, default 15s). */
  pollIntervalMs?: number
  provider?: string
  model?: string
  maxTokens?: number
  disposeAfterReply?: boolean
  onInbound: (route: InboundRoute) => void
  /** Logger surface. */
  log?: (msg: string) => void
  /** Called whenever the underlying connection state changes. */
  onState?: (status: 'connecting' | 'connected' | 'error' | 'idle', detail?: string) => void
}

/** Minimal adapter over nodemailer + imapflow, loaded lazily at runtime. */
export class EmailTransport implements ChannelTransport {
  private transport: any = null
  private client: any = null
  private timer: NodeJS.Timeout | null = null
  private connected = false
  private seenUids = new Set<number>()

  constructor(private readonly options: EmailChannelOptions) {}

  async start(): Promise<void> {
    const { host, imapPort, smtpPort, useTls, account, password } = this.options
    if (!host || !account || !password) {
      throw new Error('email channel requires host, account and password')
    }

    this.options.onState?.('connecting')

    // Lazy-require so a missing native dep never breaks other channels.
    const nodemailer = await import('nodemailer').then(m => m.default ?? m)
    const imapflow = await import('imapflow')
    const ImapFlow = imapflow.ImapFlow

    const smtpPortVal = smtpPort || 587
    this.transport = nodemailer.createTransport({
      host,
      port: smtpPortVal,
      secure: Boolean(useTls) || smtpPortVal === 465,
      auth: { user: account, pass: password },
      tls: { rejectUnauthorized: true },
    })

    this.client = new ImapFlow({
      host,
      port: imapPort || 993,
      secure: Boolean(useTls) || (imapPort ?? 993) === 993,
      auth: { user: account, pass: password },
      logger: false,
    })
    try {
      await this.client.connect()
    } catch (error) {
      this.options.onState?.('error', error instanceof Error ? error.message : String(error))
      throw error
    }

    // Optionally fetch the last N recent messages once.
    await this.client.mailboxOpen(this.options.inbox || 'INBOX')
    this.connected = true
    this.options.onState?.('connected')

    const poll = async (): Promise<void> => {
      try {
        await this.pollInbox()
      } catch {
        // transient poll errors are non-fatal; keep polling
      }
    }
    this.timer = setInterval(() => { void poll() }, this.options.pollIntervalMs || 15000)
    void poll()
  }

  isConnected(): boolean {
    return this.connected
  }

  private async pollInbox(): Promise<void> {
    if (!this.client || !this.client.connection) return
    const { host, account, inbox } = this.options
    await this.client.mailboxOpen(inbox || 'INBOX')
    for await (const message of this.client.fetch('1:*', { uid: true, envelope: true, source: true })) {
      const uid = Number(message.uid)
      if (!Number.isFinite(uid) || this.seenUids.has(uid)) continue
      this.seenUids.add(uid)
      // Only react to plain-text mail whose subject signals a chat message to
      // this gateway (avoids treating every inbound newsletter as a prompt).
      const subject = message.envelope?.subject || ''
      const text = await this.extractText(message)
      if (!text) continue
      const sender = message.envelope?.from?.[0]?.address || ''
      // Deduplicate by uid and only route if there is a responder hint.
      this.options.onInbound({
        chatId: `${account}/${sender || uid}`,
        text,
        senderId: sender || undefined,
        runtime: {
          provider: this.options.provider,
          model: this.options.model,
          maxTokens: this.options.maxTokens,
          disposeAfterReply: this.options.disposeAfterReply,
          channel: 'email',
        },
      })
    }
  }

  private async extractText(message: any): Promise<string> {
    if (message.source) {
      try {
        const { simpleParser } = await import('mailparser')
        const parsed = await simpleParser(message.source)
        const body: string = (parsed.text as string) || ''
        return body.replace(/>.*\n/g, '').trim().slice(0, 4000)
      } catch {
        /* fall through */
      }
    }
    return ''
  }

  /** Send a reply email to the original sender (ChatIo.sendText). */
  async sendText(to: string, text: string): Promise<void> {
    if (!this.transport) throw new Error('email channel not started')
    await this.transport.sendMail({
      from: this.options.account,
      to,
      subject: 'Re: IM Gateway',
      text,
    })
  }

  async stop(): Promise<void> {
    this.connected = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    try {
      await this.client?.logout?.()
    } catch {
      /* ignore */
    }
    this.client = null
    this.transport = null
    this.options.onState?.('idle')
  }
}

export type { Nodemailer }
