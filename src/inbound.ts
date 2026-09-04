import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { InboundMessage, ReplySink } from './gateway.ts'

/** Hard cap on one webhook request body (DoS guard). */
const MAX_BODY_BYTES = 1024 * 1024 // 1 MiB

/** Cap on concurrent inbound connections (DoS guard). */
const MAX_CONNECTIONS = 64

/** One webhook HTTP route = one `http` channel. */
export interface HttpRoute {
  /** URL path this route serves, e.g. /im. */
  path: string
  /** Optional shared secret; empty disables auth for this route. */
  secret: string
  /** Body field that identifies the chat. */
  chatIdField: string
  /** Body field that carries the message text. */
  textField: string
  /** Optional body field carrying the sender id. */
  senderField?: string
  /** Handle an inbound message on this route; returns a reply sink if the transport drives the reply itself. */
  onMessage: (message: InboundMessage) => Promise<ReplySink | undefined>
}

/** Outcome of parsing one request body (errors carry their HTTP status). */
type ReadJsonResult =
  | { ok: true; body?: unknown }
  | { ok: false; status: number; error: string }

/**
 * Parse the request body as JSON, tolerating empty input. The body is read
 * with a hard byte cap: oversized payloads are rejected (413) and the request
 * socket destroyed instead of buffering unbounded memory.
 */
function readJson(req: IncomingMessage): Promise<ReadJsonResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0
        req.destroy()
        resolve({ ok: false, status: 413, error: 'payload too large' })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') return resolve({ ok: true, body: undefined })
      try {
        resolve({ ok: true, body: JSON.parse(raw) as unknown })
      } catch {
        resolve({ ok: false, status: 400, error: 'malformed JSON body' })
      }
    })
    req.on('error', () => resolve({ ok: false, status: 400, error: 'request aborted' }))
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

/**
 * Shared inbound HTTP webhook server. External IM platforms POST messages here;
 * each request is routed by URL path to the matching `http` channel route.
 * Note: the received message is acked (202) immediately; the reply normally
 * goes out over the callback configured for that channel.
 */
export class InboundHttpServer {
  private readonly server: Server
  private readonly routes = new Map<string, HttpRoute>()

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void,
  ) {
    this.server = createServer((req, res) => { void this.handle(req, res) })
    // DoS guard: refuse new connections beyond a sane concurrent cap.
    this.server.maxConnections = MAX_CONNECTIONS
  }

  /** Register (or replace) a route for a given path. */
  register(route: HttpRoute): void {
    const existing = this.routes.get(route.path)
    if (existing !== undefined) {
      this.log?.(
        'warn',
        `[im-gateway] route path "${route.path}" already registered — this new route REPLACES it` +
          '; an http channel and the global webhook (or two http channels) are sharing a path.',
      )
    }
    this.routes.set(route.path, route)
  }

  /** Remove a route by path. */
  unregister(path: string): void {
    this.routes.delete(path)
  }

  listRoutes(): string[] {
    return [...this.routes.keys()]
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', reject)
        resolve()
      })
    })
  }

  /** The bound port once listening (0 = ephemeral not yet resolved). */
  address(): { port: number; host: string } | null {
    const a = this.server.address()
    if (a === null || typeof a === 'string') return this.host ? { port: 0, host: this.host } : null
    return { port: a.port, host: a.address }
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve())
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const route = this.routes.get(url.pathname)
      if (req.method !== 'POST' || route === undefined) {
        return send(res, 404, { error: 'not found' })
      }
      if (route.secret !== '') {
        const provided = String(req.headers['x-im-secret'] ?? '')
        const a = Buffer.from(provided)
        const b = Buffer.from(route.secret)
        // Constant-time comparison; unequal lengths short-circuit (no leak of
        // secret content, only of its length which is public config anyway).
        const authorized = a.length === b.length && timingSafeEqual(a, b)
        if (!authorized) {
          return send(res, 401, { error: 'unauthorized' })
        }
      }
      // Reject by Content-Length up front when the client declares an oversized
      // body (chunked bodies are still capped while streaming in readJson).
      const declared = Number(req.headers['content-length'] ?? 0)
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return send(res, 413, { error: 'payload too large' })
      }
      const parsed = await readJson(req)
      if (!parsed.ok) {
        return send(res, parsed.status, { error: parsed.error })
      }
      const body = parsed.body
      if (body === undefined || typeof body !== 'object' || body === null || Array.isArray(body)) {
        return send(res, 400, { error: 'expected a JSON object body' })
      }
      const record = body as Record<string, unknown>
      const chatId = record[route.chatIdField]
      const text = record[route.textField]
      if (typeof chatId !== 'string' || chatId === '') {
        return send(res, 400, { error: `missing field "${route.chatIdField}"` })
      }
      if (typeof text !== 'string' || text === '') {
        return send(res, 400, { error: `missing field "${route.textField}"` })
      }
      const sender = route.senderField ? record[route.senderField] : undefined
      await route.onMessage({
        chatId,
        text,
        ...(typeof sender === 'string' && sender !== '' ? { senderId: sender } : {}),
      })
      // Ack immediately; the reply goes out via the channel's callback.
      send(res, 202, { ok: true })
    } catch (error) {
      // Never leak internal error details to the external caller; log them.
      this.log?.('error', `[im-gateway] inbound ${req.url ?? ''} failed: ${error instanceof Error ? error.message : String(error)}`)
      send(res, 500, { error: 'internal error' })
    }
  }
}
