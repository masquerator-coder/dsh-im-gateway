import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Config } from './config.ts'
import type { Config as ConfigType } from './config.ts'
import { ImGateway } from './gateway.ts'
import { InboundHttpServer } from './inbound.ts'
import { ChannelManager } from './channels/manager.ts'
import { STATUS_ROUTE_PATH } from './status-proto.ts'
import { createStatusHandler, type RequestGate, type WebRouteService } from './status-route.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * DSH's web route service, provided by the peer package
     * `@deepseek-ai/dsh-host-webserver` in web profiles. Declared structurally
     * here so this plugin needs no build-time dependency on that package.
     */
    webServer: WebRouteService
  }
}

export const name = 'dsh-im-gateway'
export const inject = ['agents']
export { Config }

export function apply(ctx: Context, config: ConfigType): void {
  const gateway = new ImGateway(ctx, {
    provider: config.provider,
    model: config.model,
    cwd: config.cwd,
    agentPreset: config.agentPreset,
    allowlist: config.allowlist,
  })

  // One shared inbound HTTP server serves BOTH the legacy global webhook (at
  // config.inboundPath) and every configured `http` channel route (by path).
  const inbound = new InboundHttpServer(config.host, config.port, (level, message) => {
    ctx.logger[level](message)
  })

  // Multi-channel IM management. DSH 0.1.7 has no plugin-registrable settings
  // namespace: the channel list and the plugin-wide default working directory
  // are VOLATILE fields on this plugin's own Config, so the framework projects
  // them into the Plugins page form and writes edits straight back into these
  // references without remounting the plugin. `attach` reconciles on
  // `loader/volatile-update`, and `settings.configure` opts this instance out
  // of auto-generated pages (it ships its own panel).
  const channelManager = new ChannelManager(ctx, gateway, inbound)
  ctx.effect(
    () => channelManager.attach(config.channels, config.channelsCwd),
    'dsh-im-gateway.channels()',
  )
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      'dsh-im-gateway.settings-policy()',
    )
  })

  // Legacy single-channel path: keep the global webhook route alive exactly as
  // before, forwarding to the gateway with the legacy callback as the reply
  // sink (parity with the pre-multi-channel build).
  inbound.register({
    path: config.inboundPath,
    secret: config.secret,
    chatIdField: config.chatIdField,
    textField: config.textField,
    senderField: config.senderField,
    onMessage: async (message) => {
      const { chatId, text, senderId } = message
      const sink = async (reply: string): Promise<void> => {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        // Only echo the chat id into a header when it is header-representable:
        // `fetch` throws `TypeError: Cannot convert argument to a ByteString`
        // for any code point above 0xFF, before the request is sent — a single
        // non-ASCII chat id (a webhook may send anything) would otherwise make
        // every reply for that chat undeliverable. The id still rides the body.
        if (/^[\x20-\x7E]*$/.test(chatId)) headers[config.callbackChatHeader] = chatId
        if (config.secret !== '') headers[config.callbackSecretHeader] = config.secret
        const res = await fetch(config.callbackUrl, {
          method: 'POST',
          headers,
          // Hard timeout: a black-holed callback URL must not wedge this chat's
          // serialized turn for the undici default (~300s) twice over.
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({ chat_id: chatId, text: reply, ts: Date.now() }),
        })
        if (!res.ok) throw new Error(`callback returned ${res.status}`)
      }
      // Do NOT await: the 202 acknowledgement must return immediately (the
      // reply arrives later over the callback). `gateway.handle` owns the full
      // turn (per-session serialization + bounded reply wait) and already
      // swallows its own errors, so fire-and-forget is safe here.
      void gateway.handle({ chatId, text, senderId }, sink, {
        provider: config.provider || undefined,
        model: config.model || undefined,
        maxTokens: config.maxTokens,
        cwd: config.cwd || undefined,
        agentPreset: config.agentPreset || undefined,
        disposeAfterReply: config.disposeAfterReply,
        channel: 'http',
      }).catch((error: unknown) => {
        ctx.logger.warn(`[im-gateway] legacy webhook handle failed: ${String(error)}`)
      })
      return undefined
    },
  })

  // Live channel status for the settings panel, over a plugin-owned web route.
  // A plugin cannot publish a Remote namespace (those are Typert-generated and
  // only DSH's own client assembly may mount them — see src/status-proto.ts), so
  // the panel fetches this route same-origin instead. It is gated by the same
  // browser-auth check that guards `/api`: an unauthenticated local request must
  // not be able to read a live bind QR.
  ctx.inject(['webServer'], (webCtx: Context) => {
    const handler = createStatusHandler({
      list: () => channelManager.statusList(),
      // Resolved per request: the connection service mounts independently of
      // this plugin, so an apply-time lookup could miss it. When it is missing
      // the request is REFUSED (401) rather than admitted: this route returns a
      // live bind QR and `webServer` applies no authentication of its own, so
      // "no gate available" must never mean "open".
      reject: (req) => {
        const gate = webCtx.get('connection') as RequestGate | undefined
        if (gate === undefined) {
          webCtx.logger.warn('[im-gateway] status route: connection service unavailable; refusing (failing closed)')
          return 401
        }
        try {
          return gate.requestRejection?.(req)
        } catch (error) {
          webCtx.logger.warn(`[im-gateway] status route trust check failed: ${String(error)}`)
          return 401
        }
      },
      log: (message) => webCtx.logger.warn(message),
    })
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: STATUS_ROUTE_PATH, handler }),
      'dsh-im-gateway.status-route()',
    )
  })

  ctx.effect(() => {
    let started = false
    // The rejection MUST be handled on the promise itself, not only in the
    // disposer: `ctx.effect` never observes this promise, so a failed bind
    // (EADDRINUSE, EACCES) would otherwise surface as an unhandled rejection
    // and take the whole DSH process down instead of just this plugin. A bind
    // failure is reported and degraded past — the IM channels keep working,
    // only the inbound webhook is unavailable.
    const boot = inbound.listen().then(() => {
      started = true
      const routes = inbound.listRoutes()
      ctx.logger.info(
        `[im-gateway] inbound webhook listening on http://${config.host}:${config.port}`
          + ` routes=${routes.length ? routes.join(',') : config.inboundPath}`
          + (config.secret !== '' ? ' (secret-auth on)' : ''),
      )
    }).catch((error: unknown) => {
      ctx.logger.error(
        `[im-gateway] inbound webhook FAILED to bind ${config.host}:${config.port}: ${String(error)}`
          + ' — IM channels keep running, but the inbound webhook is unavailable',
      )
    })
    return async () => {
      await boot
      if (started) await inbound.close()
      await gateway.close()
      await channelManager.close()
    }
  }, 'dsh-im-gateway.lifecycle()')
}
