/**
 * IM-channel settings section — browser (client) half of dsh-im-gateway.
 *
 * Registers a `settings.section` entry so the left nav of the DSH settings
 * panel gains an "IM 通道" item (pushed to the end via a large `order`); the
 * registered component renders as the right-hand panel for choosing and
 * managing channels (5G消息 / email / 通用HTTP / 飞书 / 微信 / QQ).
 *
 * Footproof config model: each channel kind ships a prefill template so fixed
 * items (server URLs, ports, paths, protocol versions) are already filled in —
 * the user only provides the key/token/account. Secrets are stored inside the
 * channel record with `role('secret')` in the schema, so they are redacted on
 * every wire describe yet readable by the host transports via the settings
 * scope.
 *
 * Live connection status is pulled from the host RPC namespace `imGateway`
 * (wired by the node half); where the host lacks `ctx.remote` the panel falls
 * back to static labels.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale'
import type {} from '@deepseek-ai/dsh-client-ui-settings'
import type {} from '@deepseek-ai/dsh-api-remotes'
import { NS, zh, en } from './locales.ts'
import { ChannelsSection } from './ChannelsSection.tsx'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const inject = ['slots', 'locale', 'settingsScope', 'remote'] as any

/**
 * Mount the settings section and dictionaries.
 * @param ctx - browser plugin context (types are platform-provided).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'im-channels: dictionaries')

  // Bound to this plugin's fiber; the settings base plugin handles the
  // describe read and disposes the scope when this section unloads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scope = ctx.settingsScope.bind({ namespace: NS }) as any

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = ctx.locale.bind(NS)

  // Try to reach the host status RPC if the platform provides `ctx.remote`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const remote = (ctx.remote as any) || null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const imGateway = remote?.imGateway || null

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'im-channels',
    order: 100, // end of the left nav list
    label: () => t('nav'),
    locale: NS,
    inject: () => ({
      scope,
      imGateway,
      t,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any, ChannelsSection as any))
}
