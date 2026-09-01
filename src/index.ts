import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Config } from './config.ts'
import type { Config as ConfigType } from './config.ts'
import { ImGateway } from './gateway.ts'
import { InboundHttpServer } from './inbound.ts'
import {
  CHANNELS_NS, ChannelsSettingsSchema,
} from './channels/schema.ts'
import { ChannelManager } from './channels/manager.ts'

export const name = 'dsh-im-gateway'
export const inject = ['agents']
export { Config }
export { CHANNELS_NS, ChannelsSettingsSchema }

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
  const inbound = new InboundHttpServer(config.host, config.port)

  // Multi-channel IM management: register the durable settings namespace and
  // run every enabled channel.
  const channelManager = new ChannelManager(ctx, gateway, inbound)
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(CHANNELS_NS, ChannelsSettingsSchema)
    channelManager.attach(scope)
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
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          [config.callbackChatHeader]: chatId,
        }
        if (config.secret !== '') headers[config.callbackSecretHeader] = config.secret
        const res = await fetch(config.callbackUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ chat_id: chatId, text: reply, ts: Date.now() }),
        })
        if (!res.ok) throw new Error(`callback returned ${res.status}`)
      }
      await gateway.handle({ chatId, text, senderId }, sink, {
        provider: config.provider || undefined,
        model: config.model || undefined,
        maxTokens: config.maxTokens,
        cwd: config.cwd || undefined,
        agentPreset: config.agentPreset || undefined,
        disposeAfterReply: config.disposeAfterReply,
        channel: 'http',
      })
      return undefined
    },
  })

  // Expose live channel status to the client over RPC so the UI reflects real
  // connection state. This namespace is injected into the client half via the
  // `remote.imGateway` service (see package.json dsh.client + client/index.ts).
  // `ctx.get` reads a service WITHOUT requiring it in `inject`, returning
  // undefined when the host's runtime has no `remote` service — so hosts that
  // lack ctx.remote (e.g. the server side generally) hit the fallback below
  // instead of throwing "cannot get property remote without inject".
  const remote = ctx.get('remote')
  if (remote && typeof remote.define === 'function') {
    remote.define('imGateway', () => ({
      list: () => channelManager.statusList(),
    }))
  } else {
    // Fallback for hosts without ctx.remote: no live status RPC, UI defaults.
    ctx.logger.warn('[im-gateway] ctx.remote unavailable; live status RPC disabled')
  }

  ctx.effect(() => {
    let started = false
    const boot = inbound.listen().then(() => {
      started = true
      const routes = inbound.listRoutes()
      ctx.logger.info(
        `[im-gateway] inbound webhook listening on http://${config.host}:${config.port}`
          + ` routes=${routes.length ? routes.join(',') : config.inboundPath}`
          + (config.secret !== '' ? ' (secret-auth on)' : ''),
      )
    })
    return async () => {
      await boot.catch(() => {})
      if (started) await inbound.close()
      await gateway.close()
      await channelManager.close()
    }
  }, 'dsh-im-gateway.lifecycle()')
}
