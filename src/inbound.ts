import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { InboundMessage, ReplySink } from './gateway.ts'

/** One HTTP webhook route = one `http` channel. */
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

/** Parse the request body as JSON, tolerating empty / malformed input. */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') return resolve(undefined)
      try {
        resolve(JSON.parse(raw))
      } catch (error: unknown) {
        reject(error)
      }
    })
    req.on('error', reject)
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
  ) {
    this.server = createServer((req, res) => { void this.handle(req, res) })
  }

  /** Register (or replace) a route for a given path. */
  register(route: HttpRoute): void {
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
        const provided = req.headers['x-im-secret']
        if (provided !== route.secret) {
          return send(res, 401, { error: 'unauthorized' })
        }
      }
      const body = await readJson(req)
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
    } catch (error: unknown) {
      send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}
