/**
 * Channel-status endpoint served by the host half (see status-proto.ts for why
 * this is a web route rather than a Remote namespace).
 *
 * The handler is a pure function of its dependencies so it can be exercised
 * offline: `scripts/smoke.mts` drives it with real `node:http` request/response
 * objects and asserts the payload, the auth gate, and the method guard.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChannelStatusPayload, ChannelStatusRow } from './status-proto.ts'

/** Handler shape DSH's web route service expects. */
export type WebRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** Structural view of the peer-provided DSH web route service. */
export interface WebRouteService {
  register(route: { kind: 'exact'; path: string; handler: WebRouteHandler }): () => void
}

/** Structural view of the peer-provided browser-auth check (`dsh-client-connection`). */
export interface RequestGate {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** One channel's live state, as the channel manager reports it. */
export interface StatusSnapshotLike {
  readonly id: string
  readonly type: string
  readonly name: string
  readonly status: string
  readonly detail?: string
  readonly qr?: string
  readonly bound?: boolean
}

export interface StatusRouteDeps {
  /** Live rows, read fresh on every request (never cached). */
  list: () => readonly StatusSnapshotLike[]
  /**
   * Browser-auth gate. Absent when the host has no web carrier mounted; when
   * present, an unauthenticated request is refused exactly like `/api` is.
   */
  reject?: (req: IncomingMessage) => 401 | 403 | undefined
  log?: (message: string) => void
}

/**
 * Project internal snapshots onto the wire rows, dropping absent optionals so
 * they never ride the wire as `undefined` (JSON has no such value).
 * @param rows - live channel snapshots.
 * @returns the response body served at the status route path.
 */
export function channelStatusPayload(rows: readonly StatusSnapshotLike[]): ChannelStatusPayload {
  return {
    channels: rows.map((row): ChannelStatusRow => ({
      id: row.id,
      type: row.type,
      name: row.name,
      status: row.status,
      ...(row.detail === undefined ? {} : { detail: row.detail }),
      ...(row.qr === undefined ? {} : { qr: row.qr }),
      ...(row.bound === undefined ? {} : { bound: row.bound }),
    })),
  }
}

/**
 * Build the route handler.
 * @param deps - status source, optional auth gate, and a log sink.
 * @returns a handler that owns the full response lifecycle.
 */
export function createStatusHandler(deps: StatusRouteDeps): WebRouteHandler {
  return (req, res) => {
    const rejection = deps.reject?.(req)
    if (rejection !== undefined) {
      writeText(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET', 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    try {
      const body = JSON.stringify(channelStatusPayload(deps.list()))
      // no-store: the QR payload rotates and a cached body would strand the
      // panel on an expired bind session.
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch (error) {
      deps.log?.(`[im-gateway] status route failed: ${String(error)}`)
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'status unavailable' }))
    }
  }
}

function writeText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(body)
}
