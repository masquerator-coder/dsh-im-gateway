/**
 * In-panel directory browser (the 浏览… dialog behind 全局默认工作目录).
 *
 * WHY IN-PANEL AND NOT A NATIVE DIALOG: the directory that matters is the one on
 * the machine the AGENT runs on, which is the HOST process — not necessarily the
 * machine running the browser. Only the host can enumerate it, so the listing
 * comes from the plugin's own `/im-gateway/browse` route and this component is
 * a thin, keyboard-friendly shell over it.
 *
 * Deliberately zero-coupling: this bundle cannot import the host's dialog /
 * button primitives (they live in packages not installed here), so the overlay
 * is drawn with the same `--dsw-alias-*` design tokens the host surfaces use.
 *
 * The pure parts (URL building, payload narrowing, breadcrumbs) live in
 * ./browse-client.ts so `scripts/smoke.mts` can exercise them — a `.tsx` module
 * cannot be loaded by `node --experimental-transform-types`.
 */

import * as React from 'react'
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BrowseEntry } from '../status-proto.ts'
import {
  breadcrumbs, directoryProblem, fetchDirectory, type BrowseResult,
} from './browse-client.ts'

export interface DirectoryBrowserProps {
  /** Directory the picker opens at (the current draft; may be empty). */
  initialPath: string
  /** Called with the chosen directory when the user confirms. */
  onPick: (path: string) => void
  /** Called when the user dismisses the picker without choosing. */
  onClose: () => void
  t: (key: string) => string
}

/** Empty result used before the first response lands. */
const EMPTY: BrowseResult = { path: '', parent: null, entries: [], roots: [], error: '' }

/**
 * The picker dialog.
 * @param props - initial path, confirm/dismiss callbacks and the locale lookup.
 * @returns the overlay element.
 */
export function DirectoryBrowser(props: DirectoryBrowserProps): React.ReactElement {
  const { initialPath, onPick, onClose, t } = props
  const [current, setCurrent] = useState(initialPath)
  const [result, setResult] = useState<BrowseResult>(EMPTY)
  const [loading, setLoading] = useState(true)
  /** Typed-path box: separate from `current` so an invalid entry is not "navigated to". */
  const [typed, setTyped] = useState(initialPath)
  /** Guards against an out-of-order response overwriting a newer listing. */
  const requestSeq = useRef(0)

  const load = useCallback((path: string): void => {
    const seq = ++requestSeq.current
    setLoading(true)
    void fetchDirectory(path).then((next) => {
      // A slow response for an earlier path must never replace the listing the
      // user is now looking at (they would see the file list jump back).
      if (seq !== requestSeq.current) return
      setCurrent(next.path !== '' ? next.path : path)
      setResult(next)
      setLoading(false)
    })
  }, [])

  // Load once on mount (and whenever the caller hands over a different start).
  useEffect(() => { load(initialPath) }, [initialPath, load])

  // Escape closes the dialog. Captured on the document because the dialog is an
  // overlay: focus may be on any of its controls, and a per-element handler
  // would miss the case where the user just pressed Tab.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const crumbs = useMemo(() => breadcrumbs(current), [current])
  const problem = directoryProblem(current, result.path === current ? result : null)
  // A listing with an error must not offer "use this directory": saving a path
  // the host just failed to read is how a typo silently becomes the workspace.
  const canUse = current.trim() !== '' && result.error === '' && !loading

  return h('div', {
    // Click-outside dismiss. The overlay itself takes the click; the panel
    // below stops propagation so an inner click never closes the dialog.
    onClick: onClose,
    style: overlayStyle,
  },
    h('div', {
      onClick: (event: React.MouseEvent) => event.stopPropagation(),
      style: dialogStyle,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': t('browse.title'),
    },
      // Header
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        h('div', { style: { fontSize: '15px', fontWeight: 600 } }, t('browse.title')),
        h('button', {
          type: 'button',
          onClick: onClose,
          style: { ...ghostStyle, padding: '3px 10px', fontSize: '12px' },
        }, t('browse.close')),
      ),

      // Path box + navigation controls
      h('div', { style: { display: 'flex', gap: '6px' } },
        h('input', {
          value: typed,
          placeholder: t('browse.enterPath'),
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setTyped(event.target.value),
          onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Enter') load(typed)
          },
          style: { ...inputStyle, fontFamily: 'monospace', fontSize: '12px' },
        }),
        h('button', {
          type: 'button',
          disabled: loading,
          onClick: () => load(current),
          style: { ...ghostStyle, padding: '6px 12px', fontSize: '12px', whiteSpace: 'nowrap' },
        }, t('browse.refresh')),
      ),

      // Breadcrumb trail: every ancestor is one click, so a wrong turn is one
      // click to undo instead of retyping the whole path.
      crumbs.length > 0
        ? h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px', fontSize: '11.5px' } },
            crumbs.map((crumb, index) =>
              h('span', { key: crumb, style: { display: 'flex', alignItems: 'center' } },
                index > 0
                  ? h('span', { style: { ...secondaryTextStyle, margin: '0 2px' } }, '›')
                  : null,
                h('button', {
                  type: 'button',
                  onClick: () => { setTyped(crumb); load(crumb) },
                  // The tail is where the user IS, so it gets primary weight; the
                  // ancestors stay tertiary (the host's own crumb treatment).
                  style: crumb === crumbs[crumbs.length - 1]
                    ? { ...crumbStyle, color: 'var(--dsw-alias-label-primary)' }
                    : crumbStyle,
                  title: crumb,
                }, crumb === crumbs[crumbs.length - 1] ? crumb : shortName(crumb)),
              ),
            ),
          )
        : null,

      // Shortcuts: always shown, so there is a way back to a known-good place.
      result.roots.length > 0
        ? h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' } },
            h('span', { style: { ...secondaryTextStyle, fontSize: '11px' } }, t('browse.roots') + ':'),
            result.roots.map(root =>
              h('button', {
                key: root.id,
                type: 'button',
                onClick: () => { setTyped(root.path); load(root.path) },
                style: { ...ghostStyle, padding: '3px 9px', fontSize: '11.5px' },
                title: root.path,
              }, t('browse.root.' + root.id)),
            ),
          )
        : null,

      // Failure notice. Rendered ABOVE the list and never as an empty list: an
      // empty listing with no explanation reads as "this directory is empty".
      result.error !== ''
        ? h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)', wordBreak: 'break-all' } }, result.error)
        : null,

      // Up + listing
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        h('button', {
          type: 'button',
          // `parent === null` means this IS a root: offering "up" there is what
          // produced an endless no-op button.
          disabled: result.parent === null || loading,
          onClick: () => {
            if (result.parent === null) return
            setTyped(result.parent)
            load(result.parent)
          },
          style: { ...ghostStyle, padding: '4px 10px', fontSize: '12px' },
        }, '↑ ' + t('browse.up')),
        h('span', { style: { ...secondaryTextStyle, fontSize: '11px' } }, t('browse.inputHint')),
      ),

      h('div', { style: listStyle },
        loading && result.entries.length === 0
          ? h('div', { style: { ...secondaryTextStyle, fontSize: '12px', padding: '8px' } }, t('browse.loading'))
          : result.entries.length === 0 && result.error === ''
            ? h('div', { style: { ...secondaryTextStyle, fontSize: '12px', padding: '8px' } }, t('browse.empty'))
            : result.entries.map(entry => entryRow(entry, () => { setTyped(entry.path); load(entry.path) }, t)),
      ),

      // Footer
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } },
        h('span', {
          style: {
            ...(problem !== '' ? { color: 'var(--dsw-alias-state-error-primary)' } : secondaryTextStyle),
            fontSize: '11px', wordBreak: 'break-all', flex: '1 1 auto',
          },
        }, problem !== '' ? problem : current),
        h('button', {
          type: 'button',
          disabled: !canUse,
          onClick: () => onPick(current),
          style: { ...primaryStyle, opacity: canUse ? 1 : 0.5, cursor: canUse ? 'pointer' : 'not-allowed' },
        }, t('browse.use')),
      ),
    ),
  )
}

/**
 * One directory row. A directory the host reported as unreadable is shown but
 * not enterable: hiding it would make an existing directory look absent.
 * @param entry - the directory to render.
 * @param onOpen - invoked when the row is activated.
 * @param t - locale lookup.
 * @returns the row element.
 */
function entryRow(
  entry: BrowseEntry,
  onOpen: () => void,
  t: (key: string) => string,
): React.ReactElement {
  return h('button', {
    key: entry.path,
    type: 'button',
    disabled: !entry.readable,
    onClick: onOpen,
    title: entry.path,
    style: {
      display: 'flex', alignItems: 'center', gap: '8px', width: '100%', textAlign: 'left',
      padding: '6px 8px', borderRadius: '6px', fontSize: '12.5px',
      border: 'none', background: 'transparent',
      color: entry.readable ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-caption)',
      cursor: entry.readable ? 'pointer' : 'not-allowed',
    },
    // Hover uses the theme's own interactive fill rather than a literal grey, so
    // the highlight is correct on both themes.
    onMouseEnter: (event: React.MouseEvent<HTMLButtonElement>) => {
      if (entry.readable) event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'
    },
    onMouseLeave: (event: React.MouseEvent<HTMLButtonElement>) => {
      event.currentTarget.style.background = 'transparent'
    },
  },
    h('span', { style: { flex: 'none', color: 'var(--dsw-alias-label-secondary)' } }, '📁'),
    h('span', { style: { flex: '1 1 0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.name),
    entry.readable
      ? null
      : h('span', { style: { flex: 'none', fontSize: '10.5px', color: 'var(--dsw-alias-label-caption)' } }, t('browse.unreadable')),
  )
}

/**
 * The last path segment of a crumb, for a compact trail.
 * @param path - one breadcrumb path.
 * @returns its display name (the path itself when there is nothing to trim).
 */
function shortName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  return parts.length > 0 ? parts[parts.length - 1]! : path
}

/* --- Styles. ---
 *
 * THEME CONTRACT: every colour resolves through a DSH `--dsw-alias-*` token and
 * NONE carries a literal fallback. The first cut used invented names
 * (`--dsw-alias-bg-elevated`, `--dsw-alias-border-secondary`) with dark
 * `#1f1f1f`-style fallbacks, so on the light theme the undefined variables fell
 * through to those fallbacks and the dialog painted a dark card with dark text —
 * unreadable. The names below are the real ones, taken from the host's own
 * `ui-primitives/Modal.module.css` and
 * `ui-directory-picker-browse/DirectoryBrowser.module.css`, so the dialog is
 * built from the same vocabulary as the host's own modals in both themes.
 *
 * The mask + card pair is the host Modal's published recipe: `bg-mask-1` for the
 * scrim (it carries the blur), `bg-layer-2` for the card, `elevation-prominent`
 * for the shadow.
 */

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: '24px',
  background: 'var(--dsw-alias-bg-mask-1)',
  backdropFilter: 'var(--dsw-mask-blur)',
}
const dialogStyle: React.CSSProperties = {
  width: 'min(620px, 100%)', maxHeight: '100%',
  display: 'flex', flexDirection: 'column', gap: '14px',
  padding: '20px 22px 18px', borderRadius: '24px',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  boxShadow: 'var(--dsw-elevation-prominent)',
  overflow: 'hidden',
}
const listStyle: React.CSSProperties = {
  minHeight: '160px', maxHeight: '42vh', overflowY: 'auto',
  display: 'grid', gap: '2px', alignContent: 'start',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: '12px', padding: '6px',
}
const crumbStyle: React.CSSProperties = {
  border: 'none', background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: '12px', padding: '0 2px', cursor: 'pointer',
  maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '7px 12px', borderRadius: '22px',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  background: 'transparent', color: 'inherit', fontSize: '13px',
}
const ghostStyle: React.CSSProperties = {
  borderRadius: '8px', border: '0.5px solid var(--dsw-alias-border-l4)',
  background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
}
const primaryStyle: React.CSSProperties = {
  padding: '7px 16px', borderRadius: '8px', border: 'none',
  background: 'var(--dsw-alias-button-primary-fill)',
  // The pairing the host's own `.primary` button uses (`Button.module.css`):
  // the fill token is `button-primary-fill`, its ON-colour is
  // `label-primary-foreground`. There is no `button-primary-foreground`.
  color: 'var(--dsw-alias-label-primary-foreground)',
  fontSize: '12.5px', fontWeight: 600, whiteSpace: 'nowrap',
}

/** Secondary/muted text: one constant so the spans cannot drift to a literal grey. */
const secondaryTextStyle: React.CSSProperties = { color: 'var(--dsw-alias-label-secondary)' }