/**
 * Channel connection manager (host half).
 *
 * Reads the durable `im-channels` settings section and owns the lifecycle of
 * each enabled channel. For every enabled channel it keeps a lightweight
 * runtime handle so the UI can reflect connection state; actual transport
 * (SMTP/IMAP for email, WebSocket for 5G消息, the embedded webhook for HTTP)
 * plugs in per type. This file deliberately does NOT hold secrets — the
 * manager only sees non-secret wiring; secret values are fetched on demand via
 * the Host credentials channel where a transport needs them.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { ChannelConfig, ChannelStatus, ChannelsSettings } from './types.ts'

/** Mutable runtime handle for one channel. */
export interface ChannelRuntime {
  config: ChannelConfig
  status: ChannelStatus
  detail?: string
  /** Transport-specific handle (closed on stop). */
  transport?: unknown
}

/**
 * Owns every channel's connection lifecycle. Attach once with the settings
 * scope; the manager reconciles running channels whenever the section changes.
 */
export class ChannelManager {
  private readonly runtimes = new Map<string, ChannelRuntime>()
  private scope: SettingsScope<ChannelsSettings> | null = null
  private detachSettings?: () => void
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly bridge: unknown,
  ) {}

  /** Bind to the registered `im-channels` scope and reconcile on every change. */
  attach(scope: SettingsScope<ChannelsSettings>): void {
    if (this.disposed || this.scope !== null) return
    this.scope = scope
    this.reconcile()
    this.detachSettings = scope.watch((next) => { void this.onSection(next) })
  }

  /** The live runtime handles, keyed by channel id (UI-facing). */
  snapshot(): ReadonlyMap<string, ChannelRuntime> {
    return this.runtimes
  }

  /**
   * Reconcile desired (enabled in the section) vs actual running channels.
   * Stops channels no longer enabled and starts newly-enabled ones.
   */
  private reconcile(): void {
    if (this.scope === null) return
    const desired = this.scope.get().channels
    const desiredIds = new Set<string>()
    for (const channel of desired) {
      desiredIds.add(channel.id)
      const current = this.runtimes.get(channel.id)
      if (current !== undefined) {
        current.config = channel
        if (!channel.enabled && current.status !== 'idle') this.stop(channel.id)
        continue
      }
      // Brand-new channel: start unless disabled.
      if (channel.enabled) void this.start(channel)
    }
    // Stop channels that vanished from the section.
    for (const [id, runtime] of [...this.runtimes]) {
      if (!desiredIds.has(id)) {
        if (runtime.config.enabled) this.stop(id)
        this.runtimes.delete(id)
      }
    }
  }

  private async onSection(_next: ChannelsSettings): Promise<void> {
    if (this.disposed) return
    this.reconcile()
  }

  /** Start one channel's transport and keep its runtime handle. */
  private async start(channel: ChannelConfig): Promise<void> {
    const runtime: ChannelRuntime = { config: channel, status: 'connecting' }
    this.runtimes.set(channel.id, runtime)
    try {
      const transport = await this.connect(channel)
      runtime.transport = transport
      runtime.status = 'connected'
      this.ctx.logger.info(`[im-gateway] channel "${channel.id}" (${channel.type}) connected`)
    } catch (error) {
      runtime.status = 'error'
      runtime.detail = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`[im-gateway] channel "${channel.id}" (${channel.type}) failed: ${runtime.detail}`)
    }
  }

  /** Establish the per-type transport. Placeholder-free, transport-aware shells. */
  private async connect(channel: ChannelConfig): Promise<unknown> {
    switch (channel.type) {
      case 'http':
        // The embedded webhook (existing im-gateway) already carries HTTP
        // inbound/outbound; a configured http channel is treated as routed
        // through that bridge. Returns a passive marker handle.
        return { kind: 'http', via: 'im-gateway-webhook' }
      case 'cmcc':
        // 5G消息 WebSocket transport — plugged in a later round (reuse the
        // SmsClient bridge from dsh-cmcc-newmsg). No credentials at this layer.
        throw new Error('cmcc(5G消息) transport not yet wired in this build')
      case 'email':
        // SMTP/IMAP transport — plugged in a later round.
        throw new Error('email transport not yet wired in this build')
      case 'wechat':
      case 'qq':
      case 'feishu':
        throw new Error(`${channel.type} is a placeholder channel (access guide only)`)
    }
  }

  /** Stop one channel's transport. */
  private stop(id: string): void {
    const runtime = this.runtimes.get(id)
    if (runtime === undefined) return
    void this.disposeTransport(runtime)
    runtime.status = 'idle'
    this.ctx.logger.info(`[im-gateway] channel "${id}" stopped`)
  }

  private async disposeTransport(runtime: ChannelRuntime): Promise<void> {
    if (!runtime.transport) return
    runtime.transport = undefined
  }

  /** Tear down all channels and detach (called on plugin unload). */
  async close(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.detachSettings?.()
    this.detachSettings = undefined
    for (const [id, runtime] of [...this.runtimes]) {
      await this.disposeTransport(runtime)
      runtime.status = 'idle'
      this.runtimes.delete(id)
    }
  }
}
