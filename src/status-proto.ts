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
   * the panel encodes into a QR itself (see src/client/qr.ts).
   */
  readonly qr?: string
}

/** Response body of {@link STATUS_ROUTE_PATH}. */
export interface ChannelStatusPayload {
  readonly channels: readonly ChannelStatusRow[]
}
