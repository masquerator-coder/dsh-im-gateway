/**
 * IM-channel settings section — browser (client) half of dsh-im-gateway.
 *
 * Registers a `settings.section` entry so the left nav of the DSH settings
 * panel gains an "IM 通道" item (pushed to the end via a large `order`); the
 * registered component renders as the right-hand panel for choosing and
 * managing channels (5G消息 / email / 通用HTTP are live; 微信/QQ/飞书 are
 * access-guide placeholders).
 *
 * Data flow:
 *   - non-secret channel wiring is read/written through a bound settings scope
 *     via `ctx.settingsScope.bind` on the `im-channels` namespace (registered
 *     by the node half through `ctx.settings.register`);
 *   - secrets (apiKey, SMTP/IMAP password, webhook secret) go through
 *     `ctx.remote.credentials` and are never returned over the wire.
 *
 * The bundle esbuild emits wraps the whole module in
 * `window.__ModuleLoader__.load({id, factory})`; externals (`react`,
 * `@deepseek-ai/cordis`) resolve through the injected `require`. This file is
 * intentionally type-loose (DSH client types are not resolvable outside the
 * DSH monorepo; the runtime API is verified against the real contracts).
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale'
import type {} from '@deepseek-ai/dsh-client-ui-settings'
import type {} from '@deepseek-ai/dsh-api-remotes'
import { NS, zh, en } from './locales.ts'
import { ChannelsSection } from './ChannelsSection.tsx'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const inject = ['slots', 'locale', 'settingsScope', 'remote', 'remote.credentials'] as any

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

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'im-channels',
    order: 100, // end of the left nav list
    label: () => t('nav'),
    locale: NS,
    inject: () => ({
      scope,
      credentials: ctx.remote.credentials,
      t,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any, ChannelsSection as any))
}
