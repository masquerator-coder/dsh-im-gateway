/**
 * Wire contract between the two halves of this plugin: the host owns live
 * channel state, the settings panel renders it.
 *
 * WHY A WEB ROUTE AND NOT A REMOTE NAMESPACE: `ctx.remote.<namespace>` on the
 * client is a projection of **Typert-generated** descriptors. The browser only
 * receives the namespaces that DSH's own assembly mounts
 * (`@deepseek-ai/dsh-api-remotes/client` iterates a fixed, in-tree list of
 * `<pkg>/remote` contributions), and the client rejects any descriptor whose
 * field codec is not a generated `strict` one (`requireStrictDescriptor`). A
 * third-party plugin therefore cannot publish a Remote namespace — which is why
 * the `remote.define('imGateway', …)` this plugin used to call never delivered
 * anything to the panel (there is no such API on the host either).
 *
 * `WebServer.register` is the supported seam for a plugin-owned endpoint: the
 * panel fetches this path same-origin, so it needs no CORS arrangement, no port
 * discovery, and it rides the browser-auth cookie that guards the rest of the
 * app.
 *
 * Keep this module dependency-free: the client half imports it too.
 */

/** Absolute path of the channel-status endpoint (registered as an exact route). */
export const STATUS_ROUTE_PATH = '/im-gateway/status'

/**
 * Absolute path of the server-side directory-listing endpoint backing the
 * settings panel's directory browser.
 *
 * WHY A SECOND HOST ROUTE: the panel lets the user type a working directory,
 * and typing an absolute host path blind is the step that actually goes wrong
 * (a typo silently starts every chat in a new, wrong workspace). A browser page
 * cannot enumerate directories — `<input type="file" webkitdirectory>` only
 * yields FILES the user picked, never the directory tree, and the File System
 * Access API is Chromium-only and needs a user gesture per root. So the
 * listing has to come from the host process, which owns the filesystem the
 * agent will actually run in. Browsing a DIFFERENT machine than the host (a
 * remote DSH) is exactly why a native dialog is not the answer either.
 */
export const BROWSE_ROUTE_PATH = '/im-gateway/browse'

/**
 * One directory entry in a browse listing.
 *
 * Only DIRECTORIES are reported: the field being filled is a working
 * DIRECTORY, so files would be pure noise (and a file can never be selected).
 */
export interface BrowseEntry {
  /** Directory name (`path.basename`), for display and selection. */
  readonly name: string
  /** Absolute path of the directory, as the host will store it. */
  readonly path: string
  /**
   * Whether the directory can be entered. A directory that cannot be read
   * (permissions, or a Windows junction to an unreachable target) is still
   * listed — hiding it would make it look absent — but is not openable.
   */
  readonly readable: boolean
}

/** Response body of {@link BROWSE_ROUTE_PATH}. */
export interface BrowsePayload {
  /**
   * Absolute path of the directory being listed, or `''` when `error` is the
   * "no directory given" case (the roots view).
   */
  readonly path: string
  /**
   * Parent directory, or `null` at a filesystem root (so the panel can disable
   * "up" instead of sending the panel to a bogus path).
   */
  readonly parent: string | null
  /** Immediate subdirectories of {@link path}, name-sorted by the host. */
  readonly entries: readonly BrowseEntry[]
  /**
   * Common starting points, always reported so the panel can render shortcuts
   * even from deep inside the tree. Empty only when the host cannot resolve a
   * home directory.
   */
  readonly roots: readonly BrowseRoot[]
  /**
   * Set when the requested path could not be listed (missing directory, a file
   * rather than a directory, a permission error). When set, `entries` is empty
   * and `path` still echoes the request so the panel can show what failed —
   * a silent empty listing would read as "this directory is empty".
   */
  readonly error?: string
}

/** A named starting point in the directory browser. */
export interface BrowseRoot {
  /** i18n key suffix: `home` / `cwd` / `imWorkspace`. */
  readonly id: string
  /** Absolute path of the shortcut target. */
  readonly path: string
}

/** One channel's live state as the panel renders it. */
export interface ChannelStatusRow {
  readonly id: string
  readonly type: string
  readonly name: string
  /** `connected` / `connecting` / `error` / `idle`. */
  readonly status: string
  /** Human-readable connection note (unlock instructions, QR failures…). */
  readonly detail?: string
  /**
   * Login-QR payload. For WeChat this is the ilink bind URL — a *page* URL that
   * the panel encodes into a QR itself (see src/client/qr.ts). Absent once the
   * channel is bound: a bound channel needs no new code.
   */
  readonly qr?: string
  /**
   * Bind state for kinds that have one (wechat): `true` once the QR bind
   * completed, `false` while it is still pending, absent for other kinds. Lets
   * the panel tell "already bound, no QR needed" from "no QR yet" without
   * pattern-matching a localized detail string.
   */
  readonly bound?: boolean
}

/** Response body of {@link STATUS_ROUTE_PATH}. */
export interface ChannelStatusPayload {
  readonly channels: readonly ChannelStatusRow[]
}
