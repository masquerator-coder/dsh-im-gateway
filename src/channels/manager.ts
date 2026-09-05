import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { ChannelConfig, ChannelStatus, ChannelsSettings } from './types.ts'
import type { ImGateway } from '../gateway.ts'
import type { ChatIo, InboundRoute, TransportStatus } from '../transports/types.ts'
import type { InboundHttpServer } from '../inbound.ts'
import type { CmccTransportOptions } from '../transports/cmcc.ts'
import type { HttpChannelOptions } from '../transports/http.ts'
import type { EmailChannelOptions } from '../transports/email.ts'
import type { FeishuChannelOptions } from '../transports/feishu.ts'
import type { WechatIlinkOptions } from '../transports/wechat.ts'
import type { QQBotOptions } from '../transports/qqbot.ts'

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
        } else if (!wasEnabled && channel.enabled) {
          // Re-enabled after a disable: the record was kept in the list with
          // enabled=false (stopped but present in runtimes). Start it again.
          void this.start(channel)
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
    let transport: ChatIo | undefined
    try {
      transport = await this.buildTransport(channel, runtime)
      await transport.start()
      // Guard against supersession: if a later start()/restart() replaced this
      // runtime while we were building/connecting (rapid config edits), stop
      // the transport we just built instead of publishing it orphaned.
      if (this.runtimes.get(channel.id) !== runtime) {
        await transport.stop().catch(() => {})
        this.ctx.logger.info(`[im-gateway] channel "${channel.id}" superseded; discarded late transport`)
        return
      }
      runtime.transport = transport
      runtime.status = transport.isConnected() ? 'connected' : 'connecting'
      this.ctx.logger.info(`[im-gateway] channel "${channel.id}" (${channel.type}) connected`)
    } catch (error) {
      if (this.runtimes.get(channel.id) !== runtime) {
        // Superseded while failing — nothing to publish.
        await transport?.stop().catch(() => {})
        return
      }
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
    // Dispose the old transport and WAIT for it (stop() is fire-and-forget and
    // would let a new transport race a half-closed old one — e.g. two live
    // QQ/IMAP sessions for the same channel during the restart window).
    const old = runtime.transport
    runtime.transport = undefined
    runtime.status = 'idle'
    if (old) {
      try { await old.stop() } catch (error: unknown) {
        this.ctx.logger.warn(`[im-gateway] channel "${id}" stop during restart: ${String(error)}`)
      }
    }
    this.runtimes.delete(id)
    this.emitStatus()
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
    this.warnIfInsecureTarget(channel)
    // Every inbound message is routed into the shared gateway with the full
    // per-channel agent routing resolved HERE from the channel record (not from
    // transport options), so schema fields that a transport never saw — cwd,
    // agentPreset, maxTokens, allowlist — actually take effect. `channelKey`
    // (the channel INSTANCE id) isolates sessions between two channels of the
    // same transport type. The reply sink is looked up from the CURRENT runtime
    // at send time (the latest transport for this channel id wins).
    const routeInbound = (route: InboundRoute): void => {
      void this.gateway.handle(
        { chatId: route.chatId, text: route.text, senderId: route.senderId },
        (reply) => {
          const t = this.runtimes.get(channel.id)?.transport
          if (!t) {
            const message = `channel "${channel.id}" transport gone; reply NOT delivered`
            this.ctx.logger.warn(`[im-gateway] ${message}`)
            // Reject (not silently resolve): the caller (gateway delivery /
            // interaction bridge) must observe the failure — a silent resolve
            // would let an approval/question prompt appear delivered when it
            // was dropped, wedging the session until the reply timeout.
            return Promise.reject(new Error(message))
          }
          return t.sendText(route.chatId, reply)
        },
        {
          // Receiving channel identity: instance id for keying, type name for
          // the model-visible <dsh_im_source> metadata.
          channelKey: channel.id,
          channel: route.runtime?.channel,
          // Per-channel agent routing (explicit channel config wins over the
          // transport's own defaults which mirror the same fields).
          provider: channel.provider || route.runtime?.provider,
          model: channel.model || route.runtime?.model,
          maxTokens: channel.maxTokens || route.runtime?.maxTokens,
          cwd: channel.cwd || undefined,
          agentPreset: channel.agentPreset || undefined,
          disposeAfterReply: channel.disposeAfterReply,
          // Explicit allowlist: an unset/empty per-channel allowlist means
          // ALLOW ALL (never inherit the legacy global webhook allowlist, whose
          // sender-id semantics belong to the HTTP caller).
          allowlist: channel.allowlist ?? [],
        },
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
        const options: CmccTransportOptions = {
          apiKey: channel.apiKey || '',
          serverUrl: channel.serverUrl,
          version: channel.version,
          provider: base.provider,
          model: base.model,
          disposeAfterReply: base.disposeAfterReply,
          onInbound: routeInbound,
          onState: setState,
          log: (level, message) => this.ctx.logger[level](`[im-gateway] ${channel.id}: ${message}`),
        }
        return new CmccTransport(options) as ChatIo
      }
      case 'http': {
        const { HttpTransport } = await import('../transports/http.ts')
        const options: HttpChannelOptions = {
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
        }
        return new HttpTransport(this.inbound, options) as ChatIo
      }
      case 'email': {
        const { EmailTransport } = await import('../transports/email.ts')
        const options: EmailChannelOptions = {
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
        }
        return new EmailTransport(options) as ChatIo
      }
      case 'feishu': {
        const { FeishuTransport } = await import('../transports/feishu.ts')
        const options: FeishuChannelOptions = {
          appId: channel.appId || '',
          appSecret: channel.appSecret || '',
          provider: base.provider,
          model: base.model,
          disposeAfterReply: base.disposeAfterReply,
          onInbound: routeInbound,
          log: (m: string) => this.ctx.logger.info(`[im-gateway] ${channel.id}: ${m}`),
        }
        return new FeishuTransport(options) as ChatIo
      }
      case 'wechat': {
        const { WechatIlinkTransport } = await import('../transports/wechat.ts')
        const options: WechatIlinkOptions = {
          channelId: channel.id,
          baseUrl: channel.baseUrl || undefined,
          token: channel.token,
          provider: base.provider,
          model: base.model,
          disposeAfterReply: base.disposeAfterReply,
          onInbound: routeInbound,
          onState: setState,
          onQr: (url: string) => { runtime.qr = url; this.emitStatus() },
          log: (m: string) => this.ctx.logger.info(`[im-gateway] ${channel.id}: ${m}`),
        }
        return new WechatIlinkTransport(options) as ChatIo
      }
      case 'qq': {
        // Official QQ bot: appId/appSecret + WebSocket gateway (api.sgroup.qq.com).
        const { QQBotTransport } = await import('../transports/qqbot.ts')
        const options: QQBotOptions = {
          appId: channel.appId || '',
          clientSecret: channel.appSecret || '',
          apiBase: channel.botApiBase || undefined,
          sandbox: channel.sandbox || false,
          provider: base.provider,
          model: base.model,
          disposeAfterReply: base.disposeAfterReply,
          onInbound: routeInbound,
          onState: setState,
          log: (m: string) => this.ctx.logger.info(`[im-gateway] ${channel.id}: ${m}`),
        }
        return new QQBotTransport(options) as ChatIo
      }
    }
  }

  /**
   * Warn once per channel when a target URL carries credentials/tokens over
   * plaintext `http://` to a NON-loopback host (loopback http is fine — the
   * risk is a remote URL sniffing the secret on the wire).
   */
  private warnIfInsecureTarget(channel: ChannelConfig): void {
    const record = channel as unknown as Record<string, unknown>
    for (const key of ['callbackUrl', 'baseUrl', 'serverUrl', 'botApiBase'] as const) {
      const value = record[key]
      if (typeof value !== 'string' || !value.startsWith('http://')) continue
      let hostname = ''
      try { hostname = new URL(value).hostname } catch { continue }
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') continue
      this.ctx.logger.warn(
        `[im-gateway] channel "${channel.id}": ${key} is a remote plaintext http:// URL (${hostname}); `
        + 'tokens/secrets sent to it travel unencrypted — prefer https:// or a loopback address.',
      )
    }
  }

  /** Stop one channel's transport (fire-and-forget dispose; status set immediately). */
  private stop(id: string): void {
    const runtime = this.runtimes.get(id)
    if (runtime === undefined) return
    runtime.status = 'idle'
    void this.disposeTransport(runtime)
    this.emitStatus()
  }

  private async disposeTransport(runtime: ChannelRuntime): Promise<void> {
    const t = runtime.transport
    runtime.transport = undefined
    if (t) {
      try { await t.stop() } catch (error: unknown) {
        this.ctx.logger.warn(`[im-gateway] channel "${runtime.config.id}" stop: ${String(error)}`)
      }
    }
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
