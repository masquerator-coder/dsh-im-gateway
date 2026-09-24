/**
 * Directory-browsing endpoint served by the host half: the backend of the
 * settings panel's directory browser (see BROWSE_ROUTE_PATH in status-proto.ts
 * for why a browser page cannot enumerate directories itself).
 *
 * SECURITY POSTURE. This route answers with the host's directory structure, so
 * it is treated as at least as sensitive as the status route (which returns a
 * live bind QR):
 *
 *  - it is registered straight on `webServer`, which applies NO authentication,
 *    so the caller-supplied trust gate must ADMIT the request — and a missing or
 *    throwing gate is a REFUSAL, never "nothing to check" (fail closed);
 *  - it is READ-ONLY: `readdir` with file types, never `stat` of file contents,
 *    never a write, never a traversal of its own. The panel only ever learns
 *    names and whether a name is a readable directory;
 *  - it is GET/HEAD only, like the status route.
 *
 * Keeping the logic here (rather than inline in the handler) is what lets
 * `scripts/smoke.mts` exercise it against REAL directories — the failure modes
 * that matter (a listing that silently reads as "empty", an "up" button that
 * walks past the root, a path that is a file) are all silent in production.
 */

import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { BrowseEntry, BrowsePayload, BrowseRoot } from './status-proto.ts'

/** Dependencies of the browse backend (injectable for offline tests). */
export interface BrowseDeps {
  /** Resolve a caller-supplied path string to a directory listing. */
  list: (path: string) => Promise<string[]>
  /** Home directory used for the `home` shortcut; `''` to omit it. */
  home: string
  /** The plugin's configured cwd, offered as a shortcut when it is set. */
  cwd: string
  /** The gateway's default IM workspace, offered as a shortcut. */
  imWorkspace: string
  /** Current working directory of the host process (fallback start point). */
  processCwd: string
}

/**
 * Production dependencies: real filesystem, real home directory.
 *
 * `list` reports DIRECTORIES ONLY. A directory that cannot be read is not an
 * error for the whole listing — it is reported as an entry with
 * `readable: false` (see {@link browseDirectory}), because hiding it would make
 * an existing directory look absent.
 *
 * @returns the default dependency set.
 */
export function defaultBrowseDeps(): BrowseDeps {
  return {
    list: async (path: string) => {
      const dirents = await readdir(path, { withFileTypes: true })
      const names: string[] = []
      for (const dirent of dirents) {
        // `isDirectory()` is false for a symlink/junction even when it points at
        // a directory, so those are probed below rather than dropped: on Windows
        // a junction is a common way to reach another drive.
        if (dirent.isDirectory()) names.push(dirent.name)
        else if (dirent.isSymbolicLink()) names.push(dirent.name)
      }
      return names
    },
    home: safeHomedir(),
    cwd: '',
    imWorkspace: join(safeHomedir(), '.dsh', 'im-workspace'),
    processCwd: process.cwd(),
  }
}

/**
 * `os.homedir()` throws when the platform cannot resolve a home directory
 * (no `HOME`/`USERPROFILE` in a stripped service environment). A throwing
 * dependency here would take down the whole browse request, so it degrades to
 * "no home shortcut" instead.
 * @returns the home directory, or `''` when unresolvable.
 */
function safeHomedir(): string {
  try {
    return homedir()
  } catch {
    return ''
  }
}

/**
 * Normalize a caller-supplied path into an absolute one.
 *
 * `resolve` collapses `..` and `.` segments, which is what makes the "up" walk
 * safe: a request for `/a/b/../../..` is resolved BEFORE it is listed, so the
 * listing can never be steered by traversal syntax. `''` resolves against the
 * process cwd, which is the natural start point when the panel has no draft.
 *
 * @param path - raw path from the query string (may be relative or empty).
 * @param deps - dependency set supplying the fallback start point.
 * @returns an absolute, normalized path.
 */
export function resolveBrowsePath(path: string, deps: BrowseDeps): string {
  const trimmed = path.trim()
  if (trimmed === '') return resolve(deps.processCwd)
  return resolve(trimmed)
}

/**
 * The parent directory to offer as "up", or `null` when there is nothing to
 * walk up to.
 *
 * `dirname('/')` is `'/'` and `dirname('C:\\\\')` is `'C:\\\\'`, so comparing
 * the parent against the path is what stops "up" from becoming an infinite
 * no-op button at a root. A bare drive spec (`C:`) behaves the same way — it is
 * drive-RELATIVE on Windows, so `dirname` cannot walk above it either, and the
 * '.' it would otherwise yield is the host process's own cwd, which is not
 * where the user asked to go.
 *
 * @param path - absolute, normalized directory path.
 * @returns the parent path, or `null` when `path` cannot be walked up from.
 */
export function parentOf(path: string): string | null {
  const parent = dirname(path)
  if (parent === path) return null
  if (parent === '.' || parent === '') return null
  return parent
}

/**
 * Whether `path` is absolute AND rooted in a way the browser can navigate from.
 *
 * Used to decide whether a typed path can be offered as an "open this" target:
 * a relative path would silently resolve against the host process's cwd, which
 * is not what the user typed.
 *
 * @param path - raw path string.
 * @returns true when the string names an absolute path.
 */
export function isAbsolutePath(path: string): boolean {
  return isAbsolute(path.trim())
}

/**
 * Build the shortcut list, dropping entries that do not resolve.
 *
 * Shortcuts are always reported (even from deep inside the tree) so the panel
 * has a way back to a known-good place without retyping. Duplicates are
 * collapsed: `home` and `imWorkspace` share a prefix but differ, and the
 * plugin `cwd` frequently EQUALS the home directory.
 *
 * @param deps - dependency set supplying the candidate paths.
 * @returns the ordered, de-duplicated shortcut list.
 */
export function browseRoots(deps: BrowseDeps): BrowseRoot[] {
  const candidates: BrowseRoot[] = [
    { id: 'home', path: deps.home },
    { id: 'cwd', path: deps.cwd },
    { id: 'imWorkspace', path: deps.imWorkspace },
  ]
  const roots: BrowseRoot[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const trimmed = candidate.path.trim()
    if (trimmed === '') continue
    const normalized = resolve(trimmed)
    // Case-insensitive on Windows, where `C:\\Users` and `c:\\users` are one
    // directory: without folding, the same shortcut would appear twice.
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) continue
    seen.add(key)
    roots.push({ id: candidate.id, path: normalized })
  }
  return roots
}

/**
 * List one directory into a {@link BrowsePayload}.
 *
 * NEVER REJECTS for a bad path: an unreadable or non-existent directory comes
 * back as `error` with an EMPTY `entries`. That distinction is the whole point
 * — a silently empty listing is indistinguishable from an empty directory, and
 * the user would conclude their files are gone.
 *
 * @param requested - raw path from the caller (may be empty).
 * @param deps - dependency set (injectable for tests).
 * @returns the payload served to the panel.
 */
export async function browseDirectory(requested: string, deps: BrowseDeps): Promise<BrowsePayload> {
  const path = resolveBrowsePath(requested, deps)
  const roots = browseRoots(deps)

  // No directory was requested at all: answer with the shortcuts and NO error,
  // so the panel's first paint is a usable chooser rather than a failure.
  if (requested.trim() === '') {
    return { path: '', parent: null, entries: [], roots }
  }

  let names: string[]
  try {
    names = await deps.list(path)
  } catch (error) {
    return { path, parent: parentOf(path), entries: [], roots, error: describeFsError(error, path) }
  }

  const entries: BrowseEntry[] = []
  for (const name of names) {
    const child = join(path, name)
    entries.push({ name, path: child, readable: await isReadableDirectory(child, deps) })
  }
  // The host sorts, not the panel: `localeCompare` with the host's locale is
  // what makes `报告` and `report` land in a stable, human order, and it keeps
  // the panel free of a second, divergent ordering rule.
  entries.sort((a, b) => a.name.localeCompare(b.name))

  return { path, parent: parentOf(path), entries, roots }
}

/**
 * Probe whether a candidate directory can actually be entered.
 *
 * A directory listed by `readdir` may still be unopenable (permissions, or a
 * Windows junction/drive letter that is not mounted). The panel disables those
 * rows instead of letting the user walk into an error page.
 *
 * @param path - absolute candidate path.
 * @param deps - dependency set.
 * @returns true when the directory can be listed.
 */
async function isReadableDirectory(path: string, deps: BrowseDeps): Promise<boolean> {
  try {
    await deps.list(path)
    return true
  } catch {
    return false
  }
}

/**
 * Turn a filesystem error into an actionable, non-leaking message.
 *
 * The raw Node error text is deliberately NOT passed through: `ENOENT: no such
 * file or directory, scandir 'C:\\…'` is both noisy and inconsistent across
 * platforms. The code is what the panel can act on.
 *
 * @param error - the thrown value from the listing call.
 * @param path - the path that failed (echoed for the panel).
 * @returns a short human-readable reason.
 */
export function describeFsError(error: unknown, path: string): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : ''
  switch (code) {
    case 'ENOENT': return `目录不存在：${path}`
    case 'ENOTDIR': return `不是目录：${path}`
    case 'EACCES':
    case 'EPERM': return `没有权限读取：${path}`
    case 'EBUSY': return `目录被占用：${path}`
    case 'ELOOP': return `符号链接成环：${path}`
    case 'ENAMETOOLONG': return `路径过长：${path}`
    default: return `无法读取目录：${path}`
  }
}

/**
 * Whether a path is usable as a working-directory value on this host.
 *
 * The panel calls this before saving so a typo is rejected while the user is
 * still looking at the box. It is a real filesystem probe, not a syntax check:
 * a well-formed path to a directory that does not exist is exactly the mistake
 * this feature exists to prevent.
 *
 * @param path - candidate directory path.
 * @param deps - dependency set.
 * @returns `'ok'`, or the {@link BrowsePayload.error} string to show instead.
 */
export async function validateDirectory(path: string, deps: BrowseDeps): Promise<'ok' | string> {
  const trimmed = path.trim()
  if (trimmed === '') return 'ok' // empty means "use the fallbacks", not an error
  if (!isAbsolutePath(trimmed)) return `请填写绝对路径：${trimmed}`
  const normalized = resolve(trimmed)
  try {
    await deps.list(normalized)
    return 'ok'
  } catch (error) {
    return describeFsError(error, normalized)
  }
}

/** Re-exported for the handler's basename needs (kept out of the client bundle). */
export { basename, sep }