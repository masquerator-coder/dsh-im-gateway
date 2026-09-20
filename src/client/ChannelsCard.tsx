/**
 * IM-channel configuration entry — the DSH Plugins page's view of this bundle.
 *
 * The page (`ui-plugin-manager`) renders every configuration entry in the two
 * views its `plugins.bundle.config` contract asks for:
 *
 *   view: 'summary' — returned as the card's one-liner, under the title.
 *   view: 'page'    — returned inside the plugin's page (`data-plugin-config`),
 *                     with its own save control; the page draws the crumb, the
 *                     icon and the title.
 *
 * So this file no longer draws card chrome (the old expandable
 * `settings.plugin.item` card did, mirroring the host's `PluginCard`): the page
 * owns all of it. What is left is the two bodies plus the `view` switch.
 *
 * Deliberately zero-coupling: the client half cannot import the host's
 * primitives or its card shell (they belong to
 * `@deepseek-ai/dsh-client-ui-primitives` / `ui-settings-plugins`, not
 * installed here), so the panel references the same `--dsw-alias-*` design
 * variables the host surfaces use.
 */

import * as React from 'react'
import { createElement as h } from 'react'
import { ChannelsSection } from './ChannelsSection.tsx'

/** Props the entry's slot registration injects (bound in `client/index.ts`). */
export interface ChannelsConfigEntryProps {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  scope: any
  t: (key: string) => string
  /** Which view the Plugins page is asking for (owner props of the slot). */
  view: 'summary' | 'page'
}

/**
 * The bundle's configuration as the Plugins page renders it: a one-line
 * summary on the card, the channel-management panel on the plugin's page.
 *
 * The summary is returned as a BARE STRING, not an element: the page places it
 * inside `<span className={css.cardDesc}>` beside the bundle title, so a
 * wrapper element would sit in that flex row for nothing. React renders a
 * string child as a text node, which is exactly the shape the seat wants.
 */
export function ChannelsConfigEntry(props: ChannelsConfigEntryProps): React.ReactNode {
  const { scope, t, view } = props
  if (view === 'summary') return t('card.description')
  // The page only ever asks for the two views above; anything else renders
  // nothing rather than guessing.
  if (view !== 'page') return null
  return h('div', { style: pageStyle }, h(ChannelsSection, { scope, t }))
}

/* --- Page body, styled with the same DSW tokens as the host's sections. --- */

const pageStyle: React.CSSProperties = {
  padding: '4px 0',
  color: 'var(--dsw-alias-label-primary)',
}
