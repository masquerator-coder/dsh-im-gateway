import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.ts'
import type { Config as ConfigType } from './config.ts'
import { ImGateway } from './gateway.ts'
import { InboundHttpServer } from './inbound.ts'

export const name = 'dsh-im-gateway'
export const inject = ['agents']
export { Config }

export function apply(ctx: Context, config: ConfigType): void {
  const gateway = new ImGateway(ctx, config)
  const server = new InboundHttpServer(config, (message) => gateway.handle(message))

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
    }
  }, 'dsh-im-gateway.lifecycle()')
}
