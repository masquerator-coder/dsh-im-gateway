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
import { browseDirectory, type BrowseDeps } from './browse-route.ts'

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
   * Browser-auth gate. This route is registered directly on `webServer`, which
   * applies NO authentication of its own, so the gate is what stands between an
   * unauthenticated caller and a live bind QR. It returns the refusal status, or
   * `undefined` to admit. A throw (service not mounted yet) is treated as a
   * refusal — see the handler.
   */
  reject?: (req: IncomingMessage) => 401 | 403 | undefined
  log?: (message: string) => void
}

export interface BrowseRouteDeps {
  /**
   * Directory source. Injectable so `scripts/smoke.mts` can exercise the route
   * against real temp directories (and against failures) without depending on
   * the machine the suite happens to run on.
   */
  browse: BrowseDeps
  /** Browser-auth gate; same fail-closed contract as {@link StatusRouteDeps.reject}. */
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
    if (!admit(req, res, deps.reject, deps.log, 'status route')) return
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

/**
 * Apply the shared admission rules to a plugin-owned web route: browser-auth
 * gate, then the GET/HEAD method guard. Writes the refusal itself.
 *
 * WHY THIS IS SHARED RATHER THAN DUPLICATED: both routes hang off
 * `webServer.register`, which applies NO authentication of its own, and both
 * answer with material a local unauthenticated caller must not read (a live
 * bind QR; the host's directory tree). The gate resolution is per REQUEST
 * because the connection service mounts independently of this plugin, so the
 * "gate not available yet" case is a real startup race — and it must REFUSE,
 * never degrade to open. A second hand-rolled copy of that rule is exactly how
 * one route ends up admitting what the other refuses.
 *
 * @param req - incoming request.
 * @param res - response (written to on refusal).
 * @param reject - trust gate, or `undefined` when the service is unavailable.
 * @param log - optional warning sink.
 * @param label - route name used in the warning message.
 * @returns true when the caller may proceed; false when a refusal was written.
 */
function admit(
  req: IncomingMessage,
  res: ServerResponse,
  reject: StatusRouteDeps['reject'],
  log: StatusRouteDeps['log'],
  label: string,
): boolean {
  let rejection: 401 | 403 | undefined
  if (reject === undefined) {
    log?.(`[im-gateway] ${label} refused: connection trust service unavailable (failing closed)`)
    rejection = 401
  } else {
    try {
      rejection = reject(req)
    } catch (error) {
      log?.(`[im-gateway] ${label} refused: trust check failed: ${String(error)}`)
      rejection = 401
    }
  }
  if (rejection !== undefined) {
    writeText(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
    return false
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET', 'content-type': 'text/plain; charset=utf-8' })
    res.end('method not allowed')
    return false
  }
  return true
}

/**
 * Build the directory-browsing route handler (the settings panel's picker).
 * @param deps - directory source, trust gate, and a log sink.
 * @returns a handler that owns the full response lifecycle.
 */
export function createBrowseHandler(deps: BrowseRouteDeps): WebRouteHandler {
  return async (req, res) => {
    // Same fail-closed admission as the status route: this endpoint enumerates
    // the HOST's filesystem, so an unauthenticated local caller must not reach
    // it (`webServer` authenticates nothing by itself).
    if (!admit(req, res, deps.reject, deps.log, 'browse route')) return
    try {
      const requested = pathFromRequest(req)
      const payload = await browseDirectory(requested, deps.browse)
      writeJson(res, 200, payload, req.method === 'HEAD')
    } catch (error) {
      // `browseDirectory` already converts filesystem failures into a payload
      // `error`; anything reaching here is a bug in the projection itself, and
      // it must be visible rather than a 200 with a misleadingly empty listing.
      deps.log?.(`[im-gateway] browse route failed: ${String(error)}`)
      writeJson(res, 500, { path: '', parent: null, entries: [], roots: [], error: 'browse unavailable' },
        req.method === 'HEAD')
    }
  }
}

/**
 * Read the requested directory from the query string.
 *
 * `path` is the only parameter; a repeated `?path=a&path=b` arrives as an array
 * and the first value wins (never a concatenation, which would invent a path
 * that was never asked for).
 * @param req - incoming request.
 * @returns the raw path string (empty when absent).
 */
function pathFromRequest(req: IncomingMessage): string {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const value = url.searchParams.get('path')
  return value ?? ''
}

/**
 * Write a JSON response body.
 * @param res - response to write.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 * @param head - true for a HEAD request (headers only, no body).
 */
function writeJson(res: ServerResponse, status: number, body: unknown, head: boolean): void {
  // no-store on both outcomes: a cached listing would show the user a stale
  // tree after they created the directory they were looking for.
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(head ? undefined : JSON.stringify(body))
}
