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
  const gateway = new ImGateway(ctx, config)
  const server = new InboundHttpServer(config, (message) => gateway.handle(message))

  // Multi-channel IM management: register the durable settings namespace and
  // run every enabled channel. Non-secret wiring lives in `im-channels`;
  // secrets are stored via the Host credentials channel (never here, and
  // redacted on the wire by `role('secret')`).
  const channelManager = new ChannelManager(ctx, gateway)
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(CHANNELS_NS, ChannelsSettingsSchema)
    channelManager.attach(scope)
  })

  ctx.effect(() => {
    let started = false
    const boot = server.listen().then(() => {
      started = true
      ctx.logger.info(
        `[im-gateway] inbound webhook listening on http://${config.host}:${config.port}${config.inboundPath}`
          + (config.secret !== '' ? ' (secret-auth on)' : ' (no-auth)'),
      )
    })
    return async () => {
      await boot.catch(() => {})
      if (started) await server.close()
      await gateway.close()
      await channelManager.close()
    }
  }, 'dsh-im-gateway.lifecycle()')
}
