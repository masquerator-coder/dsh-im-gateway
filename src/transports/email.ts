import type { ChannelTransport, InboundRoute } from './types.ts'

// nodemailer (SMTP outbound) and imapflow (IMAP inbound) are bundled runtime
// deps of this plugin (both MIT).

import type * as Nodemailer from 'nodemailer'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'

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

/** Persisted-dedup cursor file: one JSON `{ lastUid }` per account+inbox. */
function stateFileFor(host: string, account: string, inbox: string): string {
  const key = createHash('sha1')
    .update(`${host}|${account}|${inbox}`)
    .digest('hex')
    .slice(0, 16)
  return join(homedir(), '.dsh', 'im-workspace', 'email-state', `${key}.json`)
}

/**
 * First-poll scan window: a fresh account ingests at most this many recent
 * messages (bounded by mailbox uidNext) instead of downloading the whole
 * inbox history on first connect.
 */
const INITIAL_SCAN_MESSAGES = 50

/**
 * Extract the real recipient address from a compound email chatId. The email
 * chatId doubles as the session key and is `${account}/${sender}` (see
 * pollInbox); only the part after the first '/' is a real SMTP recipient.
 * Exported as a pure function so it is unit-testable without an SMTP client.
 */
export function recipientOf(chatId: string): string {
  const slash = chatId.indexOf('/')
  return slash >= 0 ? chatId.slice(slash + 1) : chatId
}

/** Minimal adapter over nodemailer + imapflow, loaded lazily at runtime. */
export class EmailTransport implements ChannelTransport {
  private transport: any = null
  private client: any = null
  private timer: NodeJS.Timeout | null = null
  private connected = false
  /** Highest UID already processed, persisted across restarts. */
  private lastUid = 0
  /** Consecutive poll failures (triggers an error state after a threshold). */
  private pollFailures = 0

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

    // Load the persisted last-processed UID cursor so a restart never replays
    // the whole inbox (dedup survives process boundaries).
    await this.loadCursor()
    if (this.lastUid > 0) {
      this.options.log?.(`email resume: continuing from lastUid=${this.lastUid}`)
    }

    const poll = async (): Promise<void> => {
      try {
        await this.pollInbox()
        // Recovery from a previous error state: report connected again.
        if (this.pollFailures > 0) {
          this.pollFailures = 0
          this.options.onState?.('connected')
        }
      } catch (error) {
        this.pollFailures += 1
        // Repeated poll failures mean the IMAP connection is unhealthy — surface
        // it to the UI/log instead of failing silently every 15s forever.
        if (this.pollFailures >= 3) {
          this.options.onState?.('error', `poll failed ${this.pollFailures}x: ${error instanceof Error ? error.message : String(error)}`)
        }
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
    const { account, inbox } = this.options
    const mailbox = await this.client.mailboxOpen(inbox || 'INBOX')
    // First run (no persisted cursor): do NOT scan the whole inbox history —
    // start just inside the most recent window so an old/large mailbox cannot
    // stall the first poll. Once the cursor is persisted, polling is strictly
    // incremental (uidNext only advances).
    if (this.lastUid === 0) {
      const uidNext = Number(mailbox?.uidNext) || 0
      if (uidNext > 1) {
        this.lastUid = Math.max(0, uidNext - INITIAL_SCAN_MESSAGES - 1)
        this.options.log?.(`email first run: scanning the newest ${INITIAL_SCAN_MESSAGES} messages (uidNext=${uidNext})`)
      }
    }
    // Incremental fetch: only messages newer than the last processed UID. UIDs
    // are monotonic per mailbox, so this never rescans already-handled mail and
    // only transfers the few new messages since the previous poll.
    const range = this.lastUid > 0 ? `${this.lastUid + 1}:*` : '1:*'
    let newest = this.lastUid
    for await (const message of this.client.fetch(range, { uid: true, envelope: true, source: true })) {
      const uid = Number(message.uid)
      if (!Number.isFinite(uid) || uid <= this.lastUid) continue
      if (uid > newest) newest = uid
      const sender = message.envelope?.from?.[0]?.address || ''
      if (!sender) {
        // No From address: the message cannot be attributed to (or replied to)
        // any chat — do NOT fall back to a synthetic id (that would collide all
        // anonymous mail into one session). Advance the cursor and move on.
        this.options.log?.('email skip: message without From address')
        continue
      }
      const text = await this.extractText(message)
      if (!text) continue
      this.options.onInbound({
        chatId: `${account}/${sender}`,
        text,
        senderId: sender,
        runtime: {
          provider: this.options.provider,
          model: this.options.model,
          maxTokens: this.options.maxTokens,
          disposeAfterReply: this.options.disposeAfterReply,
          channel: 'email',
        },
      })
    }
    // Persist the cursor so the next poll (and a restart) continues from here.
    if (newest > this.lastUid) {
      this.lastUid = newest
      await this.saveCursor()
    }
  }

  /** Read the persisted last-processed UID for this account+inbox, if any. */
  private async loadCursor(): Promise<void> {
    try {
      const { host, account, inbox } = this.options
      const file = stateFileFor(host, account, inbox || 'INBOX')
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw) as { lastUid?: number }
      const n = Number(parsed?.lastUid)
      if (Number.isFinite(n) && n > 0) this.lastUid = n
    } catch {
      /* no state yet — first run, start from the inbox head */
    }
  }

  private async saveCursor(): Promise<void> {
    try {
      const { host, account, inbox } = this.options
      const file = stateFileFor(host, account, inbox || 'INBOX')
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, JSON.stringify({ lastUid: this.lastUid }), 'utf8')
    } catch (error) {
      this.options.log?.(`email cursor persist failed: ${String(error)}`)
    }
  }

  private async extractText(message: any): Promise<string> {
    if (message.source) {
      try {
        const { simpleParser } = await import('mailparser')
        const parsed = await simpleParser(message.source)
        let body: string = (parsed.text as string) || ''
        // Normalize line endings, then strip quoted/forwarded lines (a line
        // starting with '>') one line at a time — a whole-line regex would
        // also eat reply lines that merely begin with '>' content the user
        // wrote, and would leave `\r` fragments behind on CRLF mail.
        body = body.replace(/\r\n/g, '\n')
        body = body.split('\n')
          .filter((line) => !line.trimStart().startsWith('>'))
          .join('\n')
          .trim()
          .slice(0, 4000)
        return body
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
      to: recipientOf(to),
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
