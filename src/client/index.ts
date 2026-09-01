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
import { createElement as h } from 'react'
import { NS, zh, en } from './locales.ts'
import { ChannelsSection } from './ChannelsSection.tsx'

/**
 * Left-nav glyph for the "IM 通道" settings section: an info light-bulb
 * (信息/提示), matching the design-system `IconLightOutline16`. Rendered as an
 * inline SVG (`fill="currentColor"`, viewBox 0 0 16 16) so the client half stays
 * zero-coupling from `dsh-client-ui-primitives`, which is not installed here.
 * Projected by the settings shell as `row.icon ?? navIcon(id)`.
 */
const infoLightIcon = h(
  'svg',
  { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
  h('path', { d: 'M11.3496 8C11.3496 6.14985 9.85015 4.65039 8 4.65039C6.14985 4.65039 4.65039 6.14985 4.65039 8C4.65039 9.85015 6.14985 11.3496 8 11.3496C9.85015 11.3496 11.3496 9.85015 11.3496 8ZM12.6504 8C12.6504 10.5681 10.5681 12.6504 8 12.6504C5.43188 12.6504 3.34961 10.5681 3.34961 8C3.34961 5.43188 5.43188 3.34961 8 3.34961C10.5681 3.34961 12.6504 5.43188 12.6504 8Z', fill: 'currentColor' }),
  h('path', { d: 'M8.65039 0.5V2.5H7.34961V0.5H8.65039Z', fill: 'currentColor' }),
  h('path', { d: 'M8.65039 13.5V15.5H7.34961V13.5H8.65039Z', fill: 'currentColor' }),
  h('path', { d: 'M3.15808 2.24035L4.57229 3.65456L3.6525 4.57435L2.23829 3.16014L3.15808 2.24035Z', fill: 'currentColor' }),
  h('path', { d: 'M12.3505 11.4327L13.7647 12.8469L12.8449 13.7667L11.4307 12.3525L12.3505 11.4327Z', fill: 'currentColor' }),
  h('path', { d: 'M2.24537 12.8469L3.65958 11.4327L4.57937 12.3525L3.16516 13.7667L2.24537 12.8469Z', fill: 'currentColor' }),
  h('path', { d: 'M11.4377 3.65455L12.852 2.24033L13.7718 3.16012L12.3575 4.57434L11.4377 3.65455Z', fill: 'currentColor' }),
  h('path', { d: 'M0.5 7.35461H2.5V8.6554H0.5L0.5 7.35461Z', fill: 'currentColor' }),
  h('path', { d: 'M13.5 7.35461H15.5V8.6554H13.5V7.35461Z', fill: 'currentColor' }),
)

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
    icon: infoLightIcon,
    inject: () => ({
      scope,
      imGateway,
      t,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any, ChannelsSection as any))
}
