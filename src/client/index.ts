/**
 * IM-channel settings card — browser (client) half of dsh-im-gateway.
 *
 * Registers a `settings.plugin.item` card keyed by the plugin's settings
 * namespace (`im-channels`), so it appears inside the DSH 「插件 → 插件设置」
 * page (the configurable-plugins tab) among the other system plugin cards. The
 * card's header ("IM 通道设置") expands on click to disclose the channel
 * management panel (5G消息 / email / 通用HTTP / 飞书 / 微信 / QQ), exactly like
 * other system plugin cards — no separate entry in the Settings left nav.
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
import { ChannelsCard } from './ChannelsCard.tsx'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const inject = ['slots', 'locale', 'settingsScope', 'remote'] as any

/**
 * Mount the plugin card and dictionaries.
 * @param ctx - browser plugin context (types are platform-provided).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'im-channels: dictionaries')

  // Bound to this plugin's fiber; the settings base plugin handles the
  // describe read and disposes the scope when this card unloads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scope = ctx.settingsScope.bind({ namespace: NS }) as any

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = ctx.locale.bind(NS)

  // Try to reach the host status RPC if the platform provides `ctx.remote`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const remote = (ctx.remote as any) || null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const imGateway = remote?.imGateway || null

  // A plugin card in the configurable-plugins tab, keyed by our settings
  // namespace so the host pairs it with the served `im-channels` section. The
  // tab declares/owns `settings.plugin.item`; we only contribute one entry.
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: NS, // our settings namespace → dispatched in 插件 → 插件设置
    locale: NS,
    inject: () => ({
      scope,
      imGateway,
      t,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any, ChannelsCard as any))
}
