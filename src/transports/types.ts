/**
 * Unified transport adapter contract for dsh-im-gateway.
 *
 * Every IM channel kind (http / cmcc / email / feishu / wechat / qq) is driven
 * by exactly one adapter that implements `ChannelTransport`. The adapter owns
 * its inbound listener and routes each inbound message through the gateway via
 * a supplied callback; the gateway returns collected agent replies through the
 * `sendReply` closure the adapter captured when the message arrived.
 *
 * Secrets are resolved *before* an adapter is constructed: the manager hands
 * the adapter only the objects it needs (never raw secrets on the wire to the
 * UI). Adapters must not log secret values.
 *
 * This is a pure-type module (no runtime deps), shared by the host half only.
 */

import type { InboundMessage, MessageRuntime } from '../gateway.ts'

/** Lifecycle state surfaced to the UI / host log. */
export type TransportStatus = 'connecting' | 'connected' | 'error' | 'idle'

/** How an inbound message should be routed into the agent layer. */
export interface InboundRoute {
  /** The chat id used to derive the persistent agent session. */
  chatId: string
  /** The message text. */
  text: string
  /** Optional sender attribution. */
  senderId?: string
  /** Per-message agent routing overrides (line-work per channel). */
  runtime?: MessageRuntime
}

/**
 * The minimal transport surface the manager drives. `start()` must either
 * resolve (→ connected) or throw (→ error). Inbound messages are pushed through
 * `onInbound`, and `sendOut(reply)` is obtained from the gateway per message so
 * replies leave through the same channel that received them.
 */
export interface ChannelTransport {
  /** Establish the connection. Resolves when connected; throws on failure. */
  start(): Promise<void>
  /** Close the connection and release resources. Never throws. */
  stop(): Promise<void>
  /** True while the underlying connection is live. */
  isConnected(): boolean
}

/** A transport that can also push replies back out (all live channels). */
export interface ChatIo extends ChannelTransport {
  /** Send one reply message to a chat/contact id. */
  sendText(chatId: string, text: string): Promise<void>
}

/**
 * Factory signature. `secrets` is the resolved `{ [fieldKey]: value }` for this
 * channel (apiKey, password, app secret…). `onInbound` is how the adapter
 * pushes a received message into the gateway. Returns a started/startable
 * transport.
 */
export type TransportFactory = (
  ctx: any,
  options: {
    channelId: string
    config: Record<string, unknown>
    secrets: Record<string, string>
    /** Push one inbound message to the shared gateway. */
    onInbound: (route: InboundRoute) => void
  },
) => ChannelTransport

export type { InboundMessage }
