import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Config } from './config.ts'
import type { InboundMessage } from './gateway.ts'

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
 * Inbound HTTP webhook server. External IM platforms POST messages here;
 * each request is validated and forwarded to the gateway.
 */
export class InboundHttpServer {
  private readonly server: Server

  constructor(
    private readonly config: Config,
    private readonly onMessage: (message: InboundMessage) => void | Promise<void>,
  ) {
    this.server = createServer((req, res) => { void this.handle(req, res) })
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.removeListener('error', reject)
        resolve()
      })
    })
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve())
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      if (req.method !== 'POST' || url.pathname !== this.config.inboundPath) {
        return send(res, 404, { error: 'not found' })
      }
      if (this.config.secret !== '') {
        const provided = req.headers['x-im-secret']
        if (provided !== this.config.secret) {
          return send(res, 401, { error: 'unauthorized' })
        }
      }
      const body = await readJson(req)
      if (body === undefined || typeof body !== 'object' || body === null || Array.isArray(body)) {
        return send(res, 400, { error: 'expected a JSON object body' })
      }
      const record = body as Record<string, unknown>
      const chatId = record[this.config.chatIdField]
      const text = record[this.config.textField]
      if (typeof chatId !== 'string' || chatId === '') {
        return send(res, 400, { error: `missing field "${this.config.chatIdField}"` })
      }
      if (typeof text !== 'string' || text === '') {
        return send(res, 400, { error: `missing field "${this.config.textField}"` })
      }
      const sender = record[this.config.senderField]
      await this.onMessage({
        chatId,
        text,
        ...(typeof sender === 'string' && sender !== '' ? { senderId: sender } : {}),
      })
      // Ace the request immediately; the reply goes out via the callback.
      send(res, 202, { ok: true })
    } catch (error: unknown) {
      send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}
