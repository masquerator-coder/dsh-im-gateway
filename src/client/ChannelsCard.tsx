/**
 * IM-channel settings card — the DSH 插件 → 插件设置 entry for this plugin.
 *
 * Mirrors the chrome of the host's system plugin cards (bash / agent-loop /
 * web-search in `ui-settings-plugins`): a header button naming the plugin over
 * a one-line description, a chevron that flips when the card is open, and an
 * expanding body that discloses the channel-management UI built by
 * `ChannelsSection`. This keeps IM 通道设置 consistent with the other system
 * plugin cards ("点击展开下拉选项") instead of occupying its own Settings nav row.
 *
 * Deliberately zero-coupling: the client half cannot import the host's
 * `PluginCard` / `IconChevronDownOutline14` (they belong to
 * `@deepseek-ai/dsh-client-ui-primitives` / `ui-settings-plugins`, not
 * installed here), so the visual tokens are referenced through the same DSW
 * `--dsw-alias-*` design variables and the chevron is an inline SVG. Runtime
 * behaviour matches the verified host contract.
 */

import * as React from 'react'
import { createElement as h, useState } from 'react'
import { ChannelsSection } from './ChannelsSection.tsx'

/** Props the card's slot entry injects (bound in `client/index.ts`). */
export interface ChannelsCardProps {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  scope: any
  /** Host status RPC namespace (may be null when host lacks ctx.remote). */
  imGateway: any
  t: (key: string) => string
}

/** Expandable IM-channel settings card, consistent with other system plugin cards. */
export function ChannelsCard(props: ChannelsCardProps): React.ReactElement {
  const { scope, imGateway, t } = props
  const [open, setOpen] = useState(false)

  return h('li', { style: open ? cardOpenStyle : cardStyle },
    // Header: click to expand/collapse, exactly like a system plugin card.
    h('button', {
      type: 'button',
      'aria-expanded': open,
      onClick: () => setOpen(!open),
      style: headerStyle,
    },
      h('span', { style: headTextStyle },
        h('span', { style: nameStyle }, t('card.title')),
        h('span', { style: descStyle }, t('card.description')),
      ),
      h(Chevron, { open }),
    ),
    // Body: the channel-management panel, disclosed in place when open.
    open ? h('div', { style: bodyStyle },
      h(ChannelsSection, { scope, imGateway, t }),
    ) : null,
  )
}

/** Inline chevron that flips on open, matching `IconChevronDownOutline14`. */
function Chevron({ open }: { open: boolean }): React.ReactElement {
  return h('svg', {
    width: 14,
    height: 14,
    viewBox: '0 0 14 14',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    style: {
      flex: 'none',
      color: 'var(--dsw-alias-label-tertiary)',
      transition: 'transform .16s',
      transform: open ? 'rotate(180deg)' : 'none',
    },
  }, h('path', {
    d: 'M3.5 5.25L7 8.75L10.5 5.25',
    stroke: 'currentColor',
    strokeWidth: 1.25,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }))
}

/* --- Card chrome, styled with the same DSW tokens as host plugin cards. --- */

const cardStyle: React.CSSProperties = {
  listStyle: 'none',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: '16px',
  background: 'var(--dsw-alias-bg-layer-3)',
  transition: 'border-color .16s, background .16s',
}

/* An open card reads as the one being worked on, not merely taller. */
const cardOpenStyle: React.CSSProperties = {
  ...cardStyle,
  background: 'var(--dsw-alias-bg-layer-2)',
  borderColor: 'var(--dsw-alias-label-dimmed)',
}

const headerStyle: React.CSSProperties = {
  width: '100%',
  appearance: 'none',
  border: 0,
  background: 'none',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '14px 16px',
  borderRadius: '12px',
}

const headTextStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
}

const nameStyle: React.CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  lineHeight: 1.4,
  color: 'var(--dsw-alias-label-primary)',
}

const descStyle: React.CSSProperties = {
  fontSize: '13px',
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
}

const bodyStyle: React.CSSProperties = {
  borderTop: '0.5px solid var(--dsw-alias-border-l2)',
  margin: '0 16px',
  padding: '14px 0 8px',
}
