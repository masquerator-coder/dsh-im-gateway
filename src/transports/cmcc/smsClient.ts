import EventEmitter from 'node:events'
import WebSocket from 'ws'
import { trace } from '../../trace.ts'

/**
 * Raw WebSocket client for the China Mobile 新消息 (5G Message / RCS) gateway.
 *
 * Protocol (from the official OpenClaw cmcc-newmsg channel):
 *  - connect to `wss://...` with header `X-API-Key: <apiKey>`
 *  - on open: send `{ type:"auth", apiKey, version }`
 *  - wait for `{ type:"auth_ok" }` (reject on `auth_failed`)
 *  - heartbeat: send `{ type:"ping" }` every 15s
 *  - inbound text: `{ type:"text_message"|"message", messageId|id, from|phone, content, timestamp }`
 *  - inbound media: `{ type:"media_message", ...mediaUrl, mediaType, ... }`
 *  - outbound text: `{ type:"send", apiKey, to, content, messageId }`
 *  - outbound media: `{ type:"send", apiKey, mediaType, content, mediaUrl, messageId, ... }`
 *
 * The server occasionally emits slightly-malformed JSON; the frame repair
 * helpers below mirror the official channel's robust parsing.
 *
 * `ws` is a bundled runtime dependency of this plugin (open-source, MIT).
 */

export interface InboundMedia {
  mediaType?: string
  mediaUrl?: string
  mediaFileName?: string
  thumbnailUrl?: string
  mediaSize?: number
  mediaMimeType?: string
}

export interface InboundMessage extends InboundMedia {
  id: string
  from: string
  content: string
  timestamp: number
}

/** Loose shape of a decoded inbound frame (fields arrive with some variance). */
interface RawFrame extends InboundMedia {
  type?: string
  message?: string
  messageId?: unknown
  id?: unknown
  from?: unknown
  phone?: unknown
  content?: unknown
  timestamp?: unknown
}

const DEBUG = false

/** How often the socket watchdog samples the connection. */
const WATCHDOG_INTERVAL_MS = 5000
/**
 * How long a ping/pong round trip may stay unanswered before the socket is
 * declared dead. Only enforced once at least one `pong` has been observed, so a
 * server that never answers pings is not torn down on a false positive.
 */
const HEARTBEAT_STALE_MS = 45000

/** Leveled logger injected by the owning transport (routes into DSH's logger). */
export type SmsLog = (level: 'info' | 'warn' | 'error', message: string) => void

function log(...args: unknown[]): void {
  if (DEBUG) console.log(`[cmcc-im:${Date.now()}]`, ...args)
}

function maskApiKey(key: string): string {
  if (!key || key.length < 8) return '***'
  return `${key.slice(0, 3)}***${key.slice(-3)}`
}

export class SmsClient extends EventEmitter {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private readonly baseReconnectDelay = 3000
  private readonly maxReconnectDelay = 60000
  private heartbeatInterval: NodeJS.Timeout | null = null
  private heartbeatTimeout: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  /**
   * Independent liveness sampler. `connected` is only flipped by socket events,
   * so a half-open socket (the classic aftermath of a laptop sleep or a network
   * change: no FIN ever arrives, writes succeed into the kernel buffer) left the
   * channel reporting itself as connected while nothing could be received. The
   * watchdog inspects the real socket and forces a reconnect.
   */
  private watchdogInterval: NodeJS.Timeout | null = null
  /** Last observed `pong`; `sawPong` gates the staleness rule. */
  private lastPongAt = 0
  private sawPong = false
  /** How long to wait for the `auth_ok` frame after the socket opens. */
  private readonly authTimeoutMs = 20000
  /**
   * How long the TCP+TLS+WS handshake itself may take. `authTimeoutMs` only
   * arms AFTER `open` fires, so without this a server that accepted the TCP
   * connection but never completed the upgrade left `connect()` pending
   * forever: the transport reported 连接中 and the channel never recovered.
   */
  private readonly openTimeoutMs = 20000
  connected = false

  constructor(
    readonly apiKey: string,
    private readonly serverUrl: string,
    private readonly version: string,
    /** Optional leveled logger; when absent, diagnostics are dropped (no console). */
    private readonly emitLog?: SmsLog,
  ) {
    super()
    log('SmsClient created', { apiKey: maskApiKey(apiKey), serverUrl, version })
  }

  /** Route an error-level message through the injected logger (or drop it). */
  private errLog(message: string): void {
    if (this.emitLog) this.emitLog('error', message)
    if (DEBUG) console.error(`[cmcc-im:${Date.now()}]`, message)
  }

  connect(): Promise<void> {
    trace(`[sms] connect ${this.serverUrl} apiKey=${maskApiKey(this.apiKey)}`)
    log('connecting WebSocket', { serverUrl: this.serverUrl })
    return new Promise((resolve, reject) => {
      // `settled` guards against double-settling (a dead socket fires BOTH
      // 'error' and 'close'). A pre-auth failure REJECTS instead of leaving
      // the caller waiting on the auth timeout, so the owning transport
      // surfaces a real error state promptly.
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }
      const succeed = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      // Bound the handshake: `open` may never arrive (a half-open TCP
      // connection, a stalled TLS upgrade), and `authTimeoutMs` cannot help
      // because it only arms inside the `open` handler. Declared at promise
      // scope so every socket handler can clear it.
      const openTimeout = setTimeout(() => {
        if (settled) return
        this.errLog(`websocket open timeout after ${this.openTimeoutMs}ms`)
        try { this.ws?.terminate() } catch { /* already gone */ }
        fail(new Error(`websocket open timeout after ${this.openTimeoutMs}ms`))
      }, this.openTimeoutMs)
      const clearOpenTimeout = (): void => { clearTimeout(openTimeout) }
      try {
        this.ws = new WebSocket(this.serverUrl, {
          rejectUnauthorized: true,
          headers: { 'X-API-Key': this.apiKey },
        })
        this.ws.on('open', () => {
          clearOpenTimeout()
          trace('[sms] ws open')
          log('websocket open')
          this.connected = true
          this.ws?.send(JSON.stringify({ type: 'auth', apiKey: this.apiKey, version: this.version }))
          let authResolved = false
          const authTimeout = setTimeout(() => {
            if (authResolved) return
            authResolved = true
            if (this.ws?.readyState === WebSocket.OPEN) this.ws.close()
            fail(new Error('authentication response timeout'))
          }, this.authTimeoutMs)

          const onFrame = (data: WebSocket.RawData): void => {
            try {
              const message = JSON.parse(data.toString()) as RawFrame
              if (message.type === 'auth_ok') {
                if (authResolved) return
                authResolved = true
                clearTimeout(authTimeout)
                this.ws?.removeListener('message', onFrame)
                trace('[sms] auth ok')
                log('auth ok')
                this.reconnectAttempts = 0
                this.startHeartbeat()
                this.emit('connected')
                succeed()
              } else if (message.type === 'auth_failed') {
                if (authResolved) return
                authResolved = true
                clearTimeout(authTimeout)
                const err = new Error(message.message || 'authentication failed')
                this.errLog(`auth failed: ${String(message.message ?? '')}`)
                // Bad credentials are a configuration problem: retrying in a
                // loop cannot fix them, so stop the reconnect cycle.
                this.disconnect()
                fail(err)
              }
            } catch {
              // not yet the auth frame; ignore
            }
          }
          this.ws?.on('message', onFrame)
        })
        this.ws.on('message', (data) => {
          this.handleMessage(data.toString())
        })
        this.ws.on('close', (code, reason) => {
          clearOpenTimeout()
          trace(`[sms] ws close code=${code} reason=${reason.toString()}`)
          log('websocket closed', { code, reason: reason.toString() })
          // A close before auth completes means the connection attempt failed
          // (e.g. ECONNREFUSED); report it instead of hanging until timeout.
          if (!settled) fail(new Error(`websocket closed before authentication (code=${code})`))
          this.connected = false
          this.stopHeartbeat()
          this.emit('disconnected')
          this.attemptReconnect()
        })
        this.ws.on('error', (error) => {
          clearOpenTimeout()
          trace(`[sms] ws error ${error.message}`)
          this.errLog(`websocket error: ${error.message}`)
          this.emit('error', error)
          if (!settled) fail(error)
          this.ws?.close()
        })
      } catch (error) {
        clearOpenTimeout()
        this.errLog(`connect failed: ${String(error)}`)
        this.emit('error', error)
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  disconnect(): void {
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
    this.connected = false
  }

  sendText(to: string, content: string): Promise<string> {
    return this.sendFrame({ type: 'send', apiKey: this.apiKey, to, content }, undefined)
  }

  sendRichMedia(message: {
    mediaType?: string
    content?: string
    mediaUrl?: string
    thumbnailUrl?: string
    mediaFileName?: string
    mediaSize?: number
    mediaMimeType?: string
  }): Promise<string> {
    const payload: Record<string, unknown> = {
      type: 'send',
      apiKey: this.apiKey,
      mediaType: message.mediaType,
      content: message.content,
    }
    if (message.mediaUrl) payload.mediaUrl = message.mediaUrl
    if (message.thumbnailUrl) payload.thumbnailUrl = message.thumbnailUrl
    if (message.mediaFileName) payload.mediaFileName = message.mediaFileName
    if (message.mediaSize) payload.mediaSize = message.mediaSize
    if (message.mediaMimeType) payload.mediaMimeType = message.mediaMimeType
    return this.sendFrame(payload, message.mediaUrl)
  }

  private sendFrame(payload: Record<string, unknown>, logRef?: string): Promise<string> {
    if (!this.connected || !this.ws) {
      trace(`[sms] sendFrame REJECTED (not connected) ${JSON.stringify(payload).slice(0, 160)}`)
      return Promise.reject(new Error('websocket 未连接'))
    }
    return new Promise((resolve, reject) => {
      const messageId =
        (payload.messageId as string) ||
        `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
      const frame: Record<string, unknown> = { ...payload, messageId }
      trace(
        '[sms] sendFrame type=' + String(frame.type)
        + (frame.mediaType ? ` mediaType=${String(frame.mediaType)}` : '')
        + ` to=${String(frame.to ?? '')} len=${String(frame.content ?? '').length} id=${messageId}`,
      )
      if (frame.type === 'send' && !frame.mediaType) {
        log('send text', { to: frame.to, len: String(frame.content ?? '').length, messageId })
      } else {
        log('send media', { mediaType: frame.mediaType, ref: logRef })
      }
      this.ws!.send(JSON.stringify(frame), (error) => {
        if (error) {
          trace(`[sms] sendFrame ws.send ERROR ${error.message} id=${messageId}`)
          reject(error)
        } else {
          // PROTOCOL LIMITATION, not an oversight: the 5G-message frame set
          // (see the protocol header above) defines NO server acknowledgement
          // for an outbound `send` — the server answers a bad frame with a
          // bare `{type:"error"}` that carries no messageId, so it cannot be
          // correlated back to this send. Resolving here therefore means "the
          // bytes left this socket", NOT "the message was delivered". It is
          // logged at warn level so an undelivered reply is at least visible
          // in the host log instead of looking like a clean success.
          trace(`[sms] sendFrame ws.send OK id=${messageId} (socket-level only, no server ack)`)
          this.emitLog?.('warn', `cmcc send id=${messageId} left the socket unconfirmed (protocol has no send ack)`)
          resolve(messageId)
        }
      })
    })
  }

  isConnected(): boolean {
    return this.connected
  }

  private handleMessage(data: string): void {
    try {
      let message: RawFrame
      let fixed: string | null = null
      try {
        message = JSON.parse(data)
      } catch {
        fixed = this.tryFixJson(data) ?? this.fixContentEscaping(data)
        if (fixed) {
          try {
            message = JSON.parse(fixed)
          } catch {
            message = this.extractMessageFromRawData(data)
          }
        } else {
          message = this.extractMessageFromRawData(data)
        }
      }
      if (!message) return
      log('inbound frame', { type: message.type })
      trace(`[sms] frame type=${String(message.type)} from=${String(message.from ?? message.phone ?? '')} contentLen=${String(message.content ?? '').length}`)

      switch (message.type) {
        case 'message':
        case 'text_message':
        case 'media_message': {
          // Cannot attribute the sender? Drop the message rather than folding
          // every anonymous inbound into one shared session keyed by apiKey
          // (which would cross-contaminate unrelated senders' conversations
          // and reply to an invalid number).
          const from = String(message.from || message.phone || '').trim()
          if (!from) {
            this.errLog(`inbound ${message.type} dropped: missing from/phone`)
            break
          }
          const base = {
            id: String(message.messageId || message.id || Date.now()),
            from,
            content: String(message.content ?? ''),
            timestamp: Number(message.timestamp) || Date.now(),
          }
          if (message.type === 'media_message') {
            this.emit('message', {
              ...base,
              mediaType: message.mediaType,
              mediaUrl: message.mediaUrl,
              mediaFileName: message.mediaFileName,
              thumbnailUrl: message.thumbnailUrl,
              mediaSize: message.mediaSize,
              mediaMimeType: message.mediaMimeType,
            } satisfies InboundMessage)
          } else {
            this.emit('message', base satisfies InboundMessage)
          }
          break
        }
        case 'pong': {
          this.sawPong = true
          this.lastPongAt = Date.now()
          if (this.heartbeatTimeout) {
            clearTimeout(this.heartbeatTimeout)
            this.heartbeatTimeout = null
          }
          this.emit('heartbeat')
          break
        }
        case 'auth_ok':
          // Auth outcome is owned by the connect-time listener (onFrame).
          break
        case 'auth_failed':
          // Auth outcome is owned by the connect-time listener (onFrame),
          // which rejects and disconnects. This no-op keeps late auth frames
          // from double-closing or double-reporting the error.
          this.errLog(`late auth_failed frame: ${String(message.message ?? '')}`)
          break
        case 'error':
          this.errLog(`server error: ${String(message.message ?? '')}`)
          this.emit('error', new Error(message.message || 'unknown server error'))
          break
        default:
          log('unknown message type', message.type)
      }
    } catch (error) {
      this.errLog(`handleMessage error: ${String(error)}`)
    }
  }

  private tryFixJson(data: string): string | null {
    let fixed = data.replace(/^\uFEFF/, '').trim()
    if (fixed.startsWith('{') && !fixed.endsWith('}')) {
      const braceCount = fixed.split('{').length - fixed.split('}').length
      if (braceCount > 0) fixed += '}'.repeat(braceCount)
    }
    if (!fixed.startsWith('{') && !fixed.startsWith('[')) {
      fixed = `{${fixed}}`
    }
    return fixed !== data ? fixed : null
  }

  private fixContentEscaping(data: string): string | null {
    const contentMarker = '"content":"'
    const contentIndex = data.indexOf(contentMarker)
    if (contentIndex === -1) return null
    const valueStart = contentIndex + contentMarker.length
    const fromMarker = '","from":"'
    const fromIndex = data.indexOf(fromMarker, valueStart)
    if (fromIndex === -1) return null
    const contentValue = data.substring(valueStart, fromIndex)
    const fixedContent = this.escapeJsonString(contentValue)
    const before = data.substring(0, valueStart)
    const after = data.substring(fromIndex)
    return `${before}${fixedContent}${after}`
  }

  private escapeJsonString(str: string): string {
    let result = ''
    for (let i = 0; i < str.length; i++) {
      const char = str[i]
      const prevChar = i > 0 ? str[i - 1] : ''
      if (char === '"' && prevChar !== '\\') result += '\\"'
      else result += char
    }
    return result
  }

  private extractMessageFromRawData(data: string): RawFrame {
    const typeMatch = data.match(/"type"\s*:\s*"([^"]+)"/)
    const type = typeMatch?.[1] || 'message'
    const fromMatch = data.match(/"from"\s*:\s*"([^"]+)"/)
    const from = fromMatch?.[1] || ''
    const contentMatch = data.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    const content = contentMatch?.[1] || ''
    let rich: Partial<RawFrame> | null = null
    if (content) {
      try {
        rich = JSON.parse(content.replace(/\\"/g, '"'))
      } catch {
        rich = null
      }
    }
    return {
      type,
      id: String(rich?.messageId || Date.now()),
      from: from || rich?.phone || '',
      content: String(rich?.content || content),
      timestamp: Number(rich?.timestamp) || Date.now(),
      mediaType: rich?.mediaType,
      mediaUrl: rich?.mediaUrl,
      thumbnailUrl: rich?.thumbnailUrl,
      mediaFileName: rich?.mediaFileName,
      mediaSize: rich?.mediaSize,
      mediaMimeType: rich?.mediaMimeType,
    }
  }

  private startHeartbeat(): void {
    const HEARTBEAT_INTERVAL = 15000
    const HEARTBEAT_TIMEOUT = 10000
    this.stopHeartbeat()
    this.sawPong = false
    this.lastPongAt = Date.now()
    this.heartbeatInterval = setInterval(() => {
      if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: 'ping' }))
        } catch (error) {
          // A throwing send means the socket is already unusable; the watchdog
          // would catch it later, but there is no reason to wait.
          this.errLog(`heartbeat send failed: ${String(error)}`)
          this.dropSocket('heartbeat send failed')
          return
        }
        this.heartbeatTimeout = setTimeout(() => {
          this.errLog('heartbeat timeout')
          this.emit('error', new Error('heartbeat timeout'))
          this.dropSocket('heartbeat timeout')
        }, HEARTBEAT_TIMEOUT)
      }
    }, HEARTBEAT_INTERVAL)
    this.watchdogInterval = setInterval(() => this.checkSocketHealth(), WATCHDOG_INTERVAL_MS)
  }

  /**
   * Force the current socket closed so the normal `close` → reconnect path runs.
   * Used by the heartbeat and by {@link checkSocketHealth}; idempotent through
   * the `connected` flag.
   */
  private dropSocket(reason: string): void {
    const ws = this.ws
    if (!ws) {
      this.connected = false
      this.attemptReconnect()
      return
    }
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      // The `close` listener owns `connected = false` and the reconnect.
      try { ws.close() } catch { /* ignore */ }
      return
    }
    // No close event will arrive for an already-dead socket: recover here.
    trace(`[sms] watchdog recovering dead socket (${reason}) readyState=${ws.readyState}`)
    this.connected = false
    this.stopHeartbeat()
    this.emit('disconnected')
    this.attemptReconnect()
  }

  /**
   * Detect a connection that is not actually usable: either the socket object is
   * gone/closed, or a previously answering peer stopped answering pings. Without
   * this, a half-open socket kept `connected === true` for ever, the panel said
   * 已连接, and every inbound message was silently lost.
   */
  private checkSocketHealth(): void {
    if (!this.connected) return
    const ws = this.ws
    const open = ws !== null && ws.readyState === WebSocket.OPEN
    if (!open) {
      this.errLog(`watchdog: socket not open (readyState=${ws?.readyState ?? 'none'}), reconnecting`)
      this.emit('error', new Error('websocket watchdog: socket not open'))
      this.dropSocket('socket not open')
      return
    }
    if (this.sawPong && Date.now() - this.lastPongAt > HEARTBEAT_STALE_MS) {
      this.errLog(`watchdog: no pong for ${Math.round((Date.now() - this.lastPongAt) / 1000)}s, reconnecting`)
      this.emit('error', new Error('websocket watchdog: heartbeat stale'))
      this.dropSocket('heartbeat stale')
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout)
      this.heartbeatTimeout = null
    }
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval)
      this.watchdogInterval = null
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempts++
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay,
    )
    const finalDelay = delay + delay * 0.2 * (Math.random() - 0.5)
    log('reconnecting', { attempt: this.reconnectAttempts, delay: Math.round(finalDelay) })
    this.emit('reconnecting', { attempt: this.reconnectAttempts })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      // `connected` alone is not trustworthy — it can be stale-true on a
      // half-open socket — so an already OPEN socket is the only reason to skip;
      // otherwise any dead socket is retired before the replacement dials.
      if (this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN) return
      this.disconnect()
      this.connect().catch((error) => this.errLog(`reconnect failed: ${String(error)}`))
    }, finalDelay)
  }
}
