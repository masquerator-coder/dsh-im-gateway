/**
 * IM-channel settings — browser (client) half of dsh-im-gateway.
 *
 * Registers a `plugins.bundle.config` entry keyed by this package's name, so
 * the DSH **Plugins page** (sidebar → 插件) renders the channel-management UI on
 * *this bundle's own page*: open the card named `dsh-im-gateway` under 已安装
 * and the panel is there, between the package description and the row list.
 *
 * WHY NOT `settings.plugin.item`: that keyed card slot was the old
 * 「插件 → 插件设置」 extension point, and DSH retired it in the release that
 * moved plugin configuration onto the Plugins page (`ui-settings-plugins` no
 * longer declares it, `ConfigurablePluginsTab`/`tab-store` are gone). The
 * replacement the Plugins page declares is one of three slots — `plugins.item`
 * (for host-plane official plugins), `plugins.bundle.config` (a bundle's own
 * configuration, keyed by package name) and `plugins.row.config` (one row's
 * configuration, keyed `<package>#<row id>`). This plugin is an ordinary
 * bundle whose configuration belongs to the bundle as a whole, so it takes
 * `plugins.bundle.config`. Each entry is asked for two views: `summary` is the
 * one-liner under the card title, `page` is the form itself.
 *
 * The registration only exists while the bundle's browser half is loaded, so
 * the panel appears together with the plugin row and disappears with it.
 *
 * Foolproof config model: each channel kind ships a prefill template so fixed
 * items (server URLs, ports, paths, protocol versions) are already filled in —
 * the user only provides the key/token/account. Secrets are stored inside the
 * channel record with `role('secret')` in the schema, so they are redacted on
 * every wire describe yet readable by the host transports via the settings
 * scope.
 *
 * Live connection status is fetched by the panel from the host's
 * `/im-gateway/status` web route (registered by the node half); a plugin cannot
 * publish a `ctx.remote` namespace — see src/status-proto.ts.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale'
import type {} from '@deepseek-ai/dsh-client-ui-settings'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.bundle.config'
// entry). Cross-plugin collaboration goes through cordis services, never a
// value import (the client bundle-purity gate rejects the latter).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-api-remotes'
import { NS, zh, en } from './locales.ts'
import { BUNDLE_NAME } from './bundle-name.ts'
import { ChannelsConfigEntry } from './ChannelsCard.tsx'

export { BUNDLE_NAME }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const inject = ['slots', 'locale', 'settingsScope'] as any

/**
 * Mount the bundle's configuration entry and dictionaries.
 * @param ctx - browser plugin context (types are platform-provided).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'im-channels: dictionaries')

  // Bound to this plugin's fiber; the settings base plugin handles the
  // describe read and disposes the scope when this entry unloads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scope = ctx.settingsScope.bind({ namespace: NS }) as any

  const t = ctx.locale.bind(NS)

  // This bundle's own configuration, on its page on the Plugins page. The page
  // declares/owns `plugins.bundle.config`; we only contribute the entry keyed
  // by our package name. Live channel status is not injected here: the entry
  // fetches the host's `/im-gateway/status` route itself (src/status-route.ts),
  // because DSH's Remote namespaces are generated and closed to out-of-tree
  // plugins.
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: BUNDLE_NAME,
    locale: NS,
    inject: () => ({
      scope,
      t,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any, ChannelsConfigEntry as any))
}
