/**
 * Client-side access to the host's directory-browsing route.
 *
 * WHY THIS IS ITS OWN MODULE (and not inline in the `.tsx` browser): the panel
 * lives in a `.tsx` file, which `node --experimental-transform-types` (how
 * `scripts/smoke.mts` runs) cannot load. The rules encoded here are the ones
 * that fail SILENTLY in production — a failed listing rendered as "this
 * directory is empty", an "up" button that walks past the root, a path echoed
 * back on failure that the user then saves — so they get a real test.
 *
 * The fetch is same-origin, so it rides the browser-auth cookie that guards the
 * rest of the app; the host route is where the trust check happens.
 */

import {
  BROWSE_ROUTE_PATH,
  type BrowseEntry,
  type BrowsePayload,
  type BrowseRoot,
} from '../status-proto.ts'

/** Result of one directory listing, with transport failures normalized. */
export interface BrowseResult {
  /** Absolute path being listed (or `''` for the roots-only view). */
  path: string
  /** Parent directory, or `null` at a filesystem root. */
  parent: string | null
  /** Subdirectories, host-sorted. */
  entries: BrowseEntry[]
  /** Shortcut list (always non-empty, unless the host has no home directory). */
  roots: BrowseRoot[]
  /**
   * Human-readable reason the listing is empty, or `''` when it succeeded.
   * A non-empty value MUST be shown: rendering `entries: []` without it reads
   * as "this directory has no subdirectories", which is a different fact.
   */
  error: string
}

/** Injectable fetch, so the smoke suite can drive the client half offline. */
export type BrowseFetch = (url: string) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

/** Default transport: same-origin, never cached. */
const defaultFetch: BrowseFetch = (url) =>
  fetch(url, { credentials: 'same-origin', cache: 'no-store' })

/**
 * Build the URL for one listing.
 * @param path - directory to list; `''` asks for the roots-only view.
 * @returns the request URL (path always URI-encoded).
 */
export function browseUrl(path: string): string {
  if (path === '') return BROWSE_ROUTE_PATH
  return `${BROWSE_ROUTE_PATH}?path=${encodeURIComponent(path)}`
}

/**
 * Narrow an untrusted payload into a {@link BrowseResult}.
 *
 * Everything is validated rather than trusted: this crosses a wire boundary, and
 * a malformed `entries` (or a `parent` that is not a string) would otherwise
 * crash the picker on render instead of failing the one request.
 *
 * @param raw - parsed JSON body.
 * @returns the normalized result.
 */
export function normalizeBrowsePayload(raw: unknown): BrowseResult {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<BrowsePayload>
  const entries: BrowseEntry[] = []
  if (Array.isArray(body.entries)) {
    for (const candidate of body.entries) {
      if (typeof candidate !== 'object' || candidate === null) continue
      const entry = candidate as Partial<BrowseEntry>
      if (typeof entry.name !== 'string' || typeof entry.path !== 'string') continue
      entries.push({ name: entry.name, path: entry.path, readable: entry.readable !== false })
    }
  }
  const roots: BrowseRoot[] = []
  if (Array.isArray(body.roots)) {
    for (const candidate of body.roots) {
      if (typeof candidate !== 'object' || candidate === null) continue
      const root = candidate as Partial<BrowseRoot>
      if (typeof root.id !== 'string' || typeof root.path !== 'string') continue
      roots.push({ id: root.id, path: root.path })
    }
  }
  return {
    path: typeof body.path === 'string' ? body.path : '',
    parent: typeof body.parent === 'string' ? body.parent : null,
    entries,
    roots,
    error: typeof body.error === 'string' ? body.error : '',
  }
}

/**
 * List one directory through the host route.
 *
 * NEVER THROWS. A transport failure comes back as an `error` result carrying the
 * requested path, so the caller renders one consistent failure state instead of
 * having to distinguish "request failed" from "host said no" at every call site.
 *
 * @param path - directory to list; `''` for the roots-only view.
 * @param doFetch - transport override (tests); defaults to same-origin fetch.
 * @returns the normalized listing, never a rejection.
 */
export async function fetchDirectory(path: string, doFetch: BrowseFetch = defaultFetch): Promise<BrowseResult> {
  try {
    const response = await doFetch(browseUrl(path))
    if (!response.ok) {
      return {
        path,
        parent: null,
        entries: [],
        roots: [],
        error: response.status === 401 || response.status === 403
          ? '没有权限读取目录（请刷新页面后重试）'
          : `读取目录失败（HTTP ${response.status}）`,
      }
    }
    return normalizeBrowsePayload(await response.json())
  } catch (error) {
    return {
      path,
      parent: null,
      entries: [],
      roots: [],
      error: `读取目录失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * The breadcrumb trail for a path, root-first.
 *
 * Built by TEXT, not by `node:path`: this runs in the browser, where `node:path`
 * is unavailable and `sep` differs between the host and the page. The host is
 * the only authority on what the real separator is, so the trail is derived from
 * the string the host returned.
 *
 * @param path - absolute directory path as reported by the host.
 * @returns every ancestor from the root down to (and including) `path`.
 */
export function breadcrumbs(path: string): string[] {
  if (path === '') return []
  const windows = /^[a-zA-Z]:[\\/]/.test(path)
  const separator = windows || path.includes('\\') ? '\\' : '/'
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  const crumbs: string[] = []
  if (windows) {
    // `C:\a\b` -> ['C:\', 'C:\a', 'C:\a\b']
    let current = parts[0]! + separator
    crumbs.push(current)
    for (const part of parts.slice(1)) {
      current = current.endsWith(separator) ? current + part : current + separator + part
      crumbs.push(current)
    }
    return crumbs
  }
  if (path.startsWith('/')) {
    // POSIX: `/a/b` -> ['/', '/a', '/a/b']
    let current = ''
    crumbs.push('/')
    for (const part of parts) {
      current = current + '/' + part
      crumbs.push(current)
    }
    return crumbs
  }
  // A UNC path (`\\server\share\dir`) or anything unexpected: walk the parts
  // without inventing a root, so the trail never claims a path that was not
  // returned by the host.
  let current = ''
  for (const part of parts) {
    current = current === '' ? part : current + separator + part
    crumbs.push(current)
  }
  return crumbs
}

/**
 * Whether a Save should be blocked because of the browsed directory.
 *
 * The panel validates the typed path before writing it, because the failure this
 * feature exists to prevent — saving a path that does not exist and silently
 * starting every chat in a new, wrong workspace — is invisible at save time.
 *
 * @param path - the directory the user is about to save.
 * @param result - the last listing for that path, or `null` if never browsed.
 * @returns an error message to show, or `''` when the path is fine.
 */
export function directoryProblem(path: string, result: BrowseResult | null): string {
  if (path.trim() === '') return '' // empty = "use the fallbacks", never an error
  if (result === null || result.path !== path.trim()) return '' // unverified: do not block
  return result.error
}