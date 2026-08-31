import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { ChannelConfig, ChannelStatus, ChannelsSettings } from './types.ts'
import type { ImGateway } from '../gateway.ts'
import type { ChatIo, InboundRoute, TransportStatus } from '../transports/types.ts'
import type { InboundHttpServer } from '../inbound.ts'

/** Mutable runtime handle for one channel. */
export interface ChannelRuntime {
  config: ChannelConfig
  status: ChannelStatus
  detail?: string
  /** The live transport (set once built). */
  transport?: ChatIo
  /** Latest login QR (qq / wechat) surfaced to the UI so scan-to-login works. */
  qr?: string
}

/** Snapshot published to subscribers (and to the UI via RPC). */
export interface ChannelSnapshot {
  id: string
  type: ChannelConfig['type']
  name: string
  status: ChannelStatus
  detail?: string
  /** Latest login QR for qq / wechat (undefined elsewhere / when none yet). */
  qr?: string
}

type StatusListener = (snapshot: ChannelSnapshot[]) => void

/**
 * Owns every channel's connection lifecycle. Reads the durable `im-channels`
 * settings scope; builds the correct transport for each enabled channel,
 * routes inbound messages through the shared gateway, and pushes live status
 * snapshots to subscribers (the host provides these to the UI over RPC).
 */
export class ChannelManager {
  private readonly runtimes = new Map<string, ChannelRuntime>()
  private scope: SettingsScope<ChannelsSettings> | null = null
  private detachSettings?: () => void
  private readonly listeners = new Set<StatusListener>()
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly gateway: ImGateway,
    private readonly inbound: InboundHttpServer,
  ) {}

  /** Bind to the registered `im-channels` scope and reconcile on every change. */
  attach(scope: SettingsScope<ChannelsSettings>): void {
    if (this.disposed || this.scope !== null) return
    this.scope = scope
    this.reconcile()
    this.detachSettings = scope.watch((next) => { void this.onSection(next) })
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The live runtime handles, keyed by channel id. */
  snapshot(): ReadonlyMap<string, ChannelRuntime> {
    return this.runtimes
  }

  /** Status summaries, ordered like the settings list, for the UI RPC. */
  statusList(): ChannelSnapshot[] {
    const out: ChannelSnapshot[] = []
    for (const runtime of this.runtimes.values()) {
      out.push({
        id: runtime.config.id,
        type: runtime.config.type,
        name: runtime.config.name,
        status: runtime.status,
        detail: runtime.detail,
        ...(runtime.qr !== undefined ? { qr: runtime.qr } : {}),
      })
    }
    return out
  }

  /** Reconcile desired (enabled in the section) vs actual running channels. */
  private reconcile(): void {
    if (this.scope === null) return
    const desired = this.scope.get().channels
    const desiredIds = new Set<string>()
    for (const channel of desired) {
      desiredIds.add(channel.id)
      const current = this.runtimes.get(channel.id)
      if (current !== undefined) {
        const wasEnabled = current.config.enabled
        current.config = channel
        if (wasEnabled && !channel.enabled) {
          this.stop(channel.id)
        } else if (wasEnabled && channel.enabled) {
          // Config changed while enabled: restart to apply.
          void this.restart(channel.id)
        }
        continue
      }
      if (channel.enabled) void this.start(channel)
    }
    for (const [id, runtime] of [...this.runtimes]) {
      if (!desiredIds.has(id)) {
        if (runtime.config.enabled) this.stop(id)
        this.runtimes.delete(id)
      }
    }
    this.emitStatus()
  }

  private async onSection(_next: ChannelsSettings): Promise<void> {
    if (this.disposed) return
    this.reconcile()
  }

  /** Start one channel's transport and keep its runtime handle. */
  private async start(channel: ChannelConfig): Promise<void> {
    const runtime: ChannelRuntime = { config: channel, status: 'connecting' }
    this.runtimes.set(channel.id, runtime)
    this.emitStatus()
    try {
      const transport = await this.buildTransport(channel, runtime)
      runtime.transport = transport
      await transport.start()
      runtime.status = transport.isConnected() ? 'connected' : 'connecting'
      this.ctx.logger.info(`[im-gateway] channel "${channel.id}" (${channel.type}) connected`)
    } catch (error) {
      runtime.status = 'error'
      runtime.detail = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`[im-gateway] channel "${channel.id}" (${channel.type}) failed: ${runtime.detail}`)
    }
    this.emitStatus()
  }

  /** Restart one channel transparently after a config edit. */
  private async restart(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    await this.stop(id)
    this.runtimes.delete(id)
    if (this.scope) {
      const cfg = this.scope.get().channels.find(c => c.id === id)
      if (cfg && cfg.enabled) void this.start(cfg)
    }
  }

  /**
   * Build the right transport for one channel. The inbound handler resolves the
   * transport from the runtime at reply time (avoids a construction cycle) and
   * sends the agent reply back through the same transport that received it.
   */
  private async buildTransport(channel: ChannelConfig, runtime: ChannelRuntime): Promise<ChatIo> {
    const routeInbound = (route: InboundRoute): void => {
      void this.gateway.handle(
        { chatId: route.chatId, text: route.text, senderId: route.senderId },
        (reply) => {
          const t = this.runtimes.get(channel.id)?.transport
          if (!t) {
            this.ctx.logger.warn(`[im-gateway] ${channel.id}: reply dropped (transport gone)`)
            return Promise.resolve()
          }
          return t.sendText(route.chatId, reply)
        },
        route.runtime,
      ).catch((error: unknown) => {
        this.ctx.logger.warn(`[im-gateway] ${channel.id} inbound failed: ${String(error)}`)
      })
    }

    const setState = (status: TransportStatus, detail?: string): void => {
      runtime.status = status === 'idle' ? 'idle'
        : status === 'connecting' ? 'connecting'
        : status === 'connected' ? 'connected' : 'error'
      runtime.detail = detail
      this.emitStatus()
    }
    const base = {
      provider: channel.provider,
      model: channel.model,
      disposeAfterReply: channel.disposeAfterReply,
    }

    switch (channel.type) {
      case 'cmcc': {
        const { CmccTransport } = await import('../transports/cmcc.ts')
        return new CmccTransport({
          apiKey: channel.apiKey || '',
          serverUrl: channel.serverUrl,
          version: channel.version,
          provider: base.provider,
          model: base.model,
          disposeAfterReply: base.disposeAfterReply,
          onInbound: routeInbound,
          onState: setState,
        } as any) as unknown as ChatIo
      }
      case 'http': {
        const { HttpTransport } = await import('../transports/http.ts')
        return new HttpTransport(this.inbound, {
          path: channel.inboundPath || '/im',
          secret: channel.secret || '',
          chatIdField: channel.chatIdField || 'chat_id',
          textField: channel.textField || 'text',
          senderField: channel.senderField,
          callbackUrl: channel.callbackUrl || '',
          callbackChatHeader: channel.callbackChatHeader,
          callbackSecret: channel.secret,
          provider: base.provider,
          model: base.model,
          disposeAfterReply: base.disposeAfterReply,
          onInbound: routeInbound,
        } as any) as unknown as ChatIo
      }
      case 'email': {
        const { EmailTransport } = await import('../transports/email.ts')
        return new EmailTransport({
          host: channel.host || '',
          imapPort: channel.imapPort,
          smtpPort: channel.smtpPort,
          useTls: channel.useTls,
          account: channel.account || '',
          password: channel.password || '',
          inbox: channel.inbox,
          provider: base.provider,
          model: base.model,
          disposeAfterReply: base.disposeAfterReply,
          onInbound: routeInbound,
          onState: setState,
          log: (m: string) => this.ctx.logger.info(`[im-gateway] ${channel.id}: ${m}`),
        } as any) as unknown as ChatIo
      }
      case 'feishu': {
        const { FeishuTransport } = await import('../transports/feishu.ts')
        return new FeishuTransport({
          appId: channel.appId || '',
          appSecret: channel.appSecret || '',
          provider: base.provider,
          model: base.model,
          disposeAfterReply: base.disposeAfterReply,
          onInbound: routeInbound,
          log: (m: string) => this.ctx.logger.info(`[im-gateway] ${channel.id}: ${m}`),
        } as any) as unknown as ChatIo
      }
      case 'wechat': {
        const { WechatClawTransport } = await import('../transports/wechat.ts')
        return new WechatClawTransport({
          clawUrl: channel.clawUrl || '',
          token: channel.token,
          provider: base.provider,
          model: base.model,
          disposeAfterReply: base.disposeAfterReply,
          onInbound: routeInbound,
          onState: setState,
          onQr: (url: string) => { runtime.qr = url; this.emitStatus() },
          log: (m: string) => this.ctx.logger.info(`[im-gateway] ${channel.id}: ${m}`),
        } as any) as unknown as ChatIo
      }
      case 'qq': {
        const { QQTransport } = await import('../transports/qq.ts')
        return new QQTransport({
          qq: channel.qq,
          password: channel.qqPassword,
          provider: base.provider,
          model: base.model,
          disposeAfterReply: base.disposeAfterReply,
          onInbound: routeInbound,
          onState: setState,
          onQr: (dataUrl: string) => { runtime.qr = dataUrl; this.emitStatus() },
          log: (m: string) => this.ctx.logger.info(`[im-gateway] ${channel.id}: ${m}`),
        } as any) as unknown as ChatIo
      }
    }
  }

  /** Stop one channel's transport. */
  private stop(id: string): void {
    const runtime = this.runtimes.get(id)
    if (runtime === undefined) return
    void this.disposeTransport(runtime).then(() => { runtime.status = 'idle'; this.emitStatus() })
    runtime.status = 'idle'
    this.emitStatus()
  }

  private async disposeTransport(runtime: ChannelRuntime): Promise<void> {
    const t = runtime.transport
    runtime.transport = undefined
    if (t) await t.stop()
  }

  private emitStatus(): void {
    if (this.disposed) return
    const list = this.statusList()
    for (const listener of this.listeners) listener(list)
  }

  /** Tear down all channels and detach (called on plugin unload). */
  async close(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.detachSettings?.()
    this.detachSettings = undefined
    this.listeners.clear()
    for (const [id, runtime] of [...this.runtimes]) {
      await this.disposeTransport(runtime)
      runtime.status = 'idle'
      this.runtimes.delete(id)
    }
  }
}
