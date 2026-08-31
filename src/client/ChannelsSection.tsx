/**
 * Right-hand panel of the "IM 通道" settings section (client half).
 *
 * Shows every channel kind (微信/QQ/email/5G消息/飞书/通用HTTP), lets the user
 * pick one and either follow the access guide (placeholder kinds) or fill a
 * configuration form (email / 5G消息 / 通用HTTP). Writes happen through the
 * bound settings scope; secrets through `ctx.remote.credentials`.
 *
 * Compiled with classic-JSX by the client build step, so each element is a
 * `React.createElement`. Types are intentionally loose (`any` on DSH client
 * faces) because the DSH client types are not resolvable outside the DSH
 * monorepo; the runtime API matches the verified contracts.
 */

import * as React from 'react'
import { createElement as h, Fragment, useCallback, useMemo, useState, useSyncExternalStore } from 'react'

import {
  type ChannelConfig, type ChannelsSettings, type ChannelType,
} from '../channels/types.ts'

/** Placeholder kinds that only show an access guide (no live form). */
const GUIDE_ONLY: readonly ChannelType[] = ['wechat', 'qq', 'feishu']

const CK = {
  email: ['host', 'imapPort', 'smtpPort', 'account', 'password'],
  cmcc: ['serverUrl', 'uploadUrl', 'version', 'apiKey'],
  http: ['inboundPath', 'chatIdField', 'textField', 'callbackUrl', 'secret'],
} as const

export interface ChannelsSectionProps {
  /** Close the settings panel (shell-provided). */
  close: () => void
  /** The bound `im-channels` settings scope. */
  /* eslint-disable @typescript-eslint/no-explicit-any */
  scope: any
  /** Host credentials namespace (set/describe). */
  credentials: any
  /** Bound locale translate fn. */
  t: (key: string) => string
}

/** One editable string field of a channel, keyed by the schema field name. */
type Field = { key: string; labelKey: string; secret?: boolean }

function fieldsFor(type: ChannelType): Field[] {
  if (type === 'email') {
    return [
      { key: 'host', labelKey: 'field.host' },
      { key: 'account', labelKey: 'field.account' },
      { key: 'password', labelKey: 'field.password', secret: true },
    ]
  }
  if (type === 'cmcc') {
    return [
      { key: 'serverUrl', labelKey: 'field.serverUrl' },
      { key: 'version', labelKey: 'field.version' },
      { key: 'apiKey', labelKey: 'field.apiKey', secret: true },
    ]
  }
  // http
  return [
    { key: 'inboundPath', labelKey: 'field.inboundPath' },
    { key: 'chatIdField', labelKey: 'field.chatIdField' },
    { key: 'textField', labelKey: 'field.textField' },
    { key: 'callbackUrl', labelKey: 'field.callbackUrl' },
    { key: 'secret', labelKey: 'field.secret', secret: true },
  ]
}

/** Default non-secret wiring for a new channel of a given kind. */
function defaultsFor(type: ChannelType): Pick<ChannelConfig, 'type'> & Partial<ChannelConfig> {
  const base: Pick<ChannelConfig, 'type'> & Partial<ChannelConfig> = { type }
  if (type === 'cmcc') base.serverUrl = 'wss://5gvas01.cmicmaap.com/gtw-ai/openclaw/ws/msg'
  if (type === 'http') {
    base.inboundPath = '/im'
    base.chatIdField = 'chat_id'
    base.textField = 'text'
  }
  return base
}

/** Access guide deep-link for placeholder channels (official pages). */
function guideHref(type: ChannelType): string | undefined {
  if (type === 'wechat') return 'https://kf.weixin.qq.com/'
  if (type === 'qq') return 'https://connect.qq.com/'
  if (type === 'feishu') return 'https://open.feishu.cn/'
  return undefined
}

/**
 * The right-hand channel management panel.
 * @param props - shell + injected props.
 * @returns the panel element tree.
 */
export function ChannelsSection(props: ChannelsSectionProps): React.ReactElement {
  const { scope, credentials, t } = props

  // Subscribe to the bound scope; the snapshot carries
  // `{ status, value: ChannelsSettings, writable, ... }`.
  const snapshot = useSyncExternalStore(
    useCallback((cb: () => void) => scope.subscribe(cb), [scope]),
    useCallback(() => scope.getSnapshot(), [scope]),
  )
  const channels: ChannelConfig[] = snapshot?.value?.channels ?? []

  // Viewing state: which channel is active, and whether we're creating a new one.
  const [activeId, setActiveId] = useState<string | undefined>(
    channels.length > 0 ? channels[0]!.id : undefined,
  )
  const [creating, setCreating] = useState<ChannelType | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [draftName, setDraftName] = useState('')
  const [secretSet, setSecretSet] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  // The panel must not depend on first-mount timing: the settings snapshot can
  // resolve AFTER this component mounts (mirror cold-loads on first open). Derive
  // a safe active id so the existing-channel list renders as soon as any channel
  // is present, even if `activeId` was initialised while `channels` was empty.
  const resolvedActiveId: string | undefined = channels.some(ch => ch.id === activeId)
    ? activeId
    : channels[0]?.id
  const active = channels.find(ch => ch.id === resolvedActiveId)

  const secretRef = (channelId: string, fieldKey: string): string =>
    `im-channels/${channelId}/${fieldKey}`

  /** Load secret-set state for one channel's secret fields from credentials. */
  const loadSecrets = useCallback(async (ch: ChannelConfig | undefined): Promise<void> => {
    if (!ch) return
    const secretFields = fieldsFor(ch.type).filter(f => f.secret)
    if (secretFields.length === 0) { setSecretSet({}); return }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const answer = await credentials.describe(secretFields.map(f => secretRef(ch.id, f.key)))
    if (answer && answer.ok) {
      const map: Record<string, boolean> = {}
      for (const f of secretFields) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const info = answer.value?.[secretRef(ch.id, f.key)] as any
        map[f.key] = Boolean(info && (info.configured === true || info.set === true))
      }
      setSecretSet(map)
    }
  }, [credentials])

  // Select a channel: reset draft and load its key state.
  const select = useCallback((id: string) => {
    setActiveId(id)
    setCreating(null)
    const ch = channels.find(c => c.id === id)
    if (ch) {
      setDraftName(ch.name ?? '')
      setDraft({})
      void loadSecrets(ch)
    }
  }, [channels, loadSecrets])

  const beginCreate = useCallback((type: ChannelType) => {
    setCreating(type)
    setDraftName(`${t('type.' + type)}`)
    setDraft({})
    setSecretSet({})
    setNotice('')
  }, [t])

  const activeFields = active ? fieldsFor(active.type) : []
  const activeSecretSet = active ? (secretSet[activeFields.find(f => f.secret)?.key ?? ''] ?? false) : false

  const channelLabel = (type: ChannelType): string => t('type.' + type)

  /** Persist the current draft (create or update). */
  const save = useCallback(async (): Promise<void> => {
    setBusy(true)
    setNotice('')
    try {
      const id = creating !== null ? `ch-${Date.now().toString(36)}` : (active?.id ?? '')
      const base = active ?? defaultsFor(creating as ChannelType)
      const nextChannel: ChannelConfig = {
        ...base,
        id,
        type: (creating as ChannelType) ?? (active?.type as ChannelType),
        name: draftName || channelLabel((creating as ChannelType) ?? (active?.type as ChannelType)),
        enabled: true,
      }
      // Merge non-secret draft fields.
      for (const f of activeFields) {
        if (!f.secret) {
          const v = draft[f.key]
          if (v !== undefined && v !== '') (nextChannel as Record<string, unknown>)[f.key] = v
        }
      }
      // Write secret fields (only when the user typed something).
      for (const f of activeFields) {
        if (!f.secret) continue
        const v = draft[f.key]
        if (v !== undefined && v !== '') {
          await credentials.set(secretRef(id, f.key), v)
        }
      }
      // Persist non-secret section.
      const nextList = creating !== null
        ? [...channels, nextChannel]
        : channels.map(c => (c.id === id ? nextChannel : c))
      const section: ChannelsSettings = { channels: nextList }
      await scope.set('channels', section.channels)
      // Select the just-saved channel.
      setActiveId(id)
      setCreating(null)
      setDraft({})
      setNotice(t('channels.saved'))
    } catch (error) {
      setNotice(`${t('channels.saveFailed')}: ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [creating, active, activeFields, draft, draftName, channels, scope, credentials, t])

  const remove = useCallback(async (id: string): Promise<void> => {
    setBusy(true)
    setNotice('')
    try {
      const nextList = channels.filter(c => c.id !== id)
      await scope.set('channels', nextList)
      if (activeId === id) setActiveId(nextList[0]?.id)
      if (creating !== null) setCreating(null)
      setNotice(t('channels.saved'))
    } catch (error) {
      setNotice(`${t('channels.saveFailed')}: ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [channels, activeId, creating, scope, t])

  const statusLabel = (status: unknown): string => {
    switch (status) {
      case 'connected': return t('channels.status.connected')
      case 'connecting': return t('channels.status.connecting')
      case 'error': return t('channels.status.error')
      case 'placeholder': return t('channels.status.placeholder')
      default: return t('channels.status.idle')
    }
  }

  const guide = creating !== null || active ? guideHref((creating as ChannelType) ?? (active?.type as ChannelType)) : undefined
  const guideOnly = creating !== null ? GUIDE_ONLY.includes(creating as ChannelType)
    : active ? GUIDE_ONLY.includes((active as ChannelConfig).type) : false

  // Root: a two-pane layout inside the settings right column.
  return h('div', { style: { display: 'flex', gap: '20px', padding: '4px 0' } },
    // LEFT: channel list / pickers.
    h('div', { style: { width: '220px', flex: '0 0 auto', borderRight: '1px solid rgba(128,128,128,0.25)', paddingRight: '12px' } },
      h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '8px' } }, t('channels.add')),
      h('div', { style: { display: 'grid', gap: '6px' } },
        (['wechat', 'qq', 'email', 'cmcc', 'feishu', 'http'] as ChannelType[]).map(type =>
          h('button', {
            key: type,
            type: 'button',
            onClick: () => beginCreate(type),
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              border: '1px solid rgba(128,128,128,0.3)', borderRadius: '8px', background: 'transparent',
              color: 'inherit', padding: '8px 10px', fontSize: '13px', cursor: 'pointer', textAlign: 'left',
            },
          },
            h('span', null, channelLabel(type)),
            GUIDE_ONLY.includes(type) ? h('span', { style: { opacity: 0.6, fontSize: '11px' } }, t('channels.status.placeholder')) : null,
          ),
        ),
      ),
      channels.length > 0 ? h('div', { style: { marginTop: '14px' } },
        h('div', { style: { fontSize: '12px', opacity: 0.7, marginBottom: '6px' } }, t('channels.add') + ' · ' + t('channels.status.connected')),
        h('div', { style: { display: 'grid', gap: '6px' } },
          channels.map(ch =>
            h('div', {
              key: ch.id,
              onClick: () => select(ch.id),
              style: {
                padding: '7px 10px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px',
                border: resolvedActiveId === ch.id ? '1px solid #4f8cff' : '1px solid rgba(128,128,128,0.25)',
                background: resolvedActiveId === ch.id ? 'rgba(79,140,255,0.08)' : 'transparent',
              },
            },
              h('div', { style: { fontWeight: 600 } }, ch.name),
              h('div', { style: { fontSize: '11px', opacity: 0.65 } },
                channelLabel(ch.type) + ' · ' + statusLabel(ch.enabled ? 'connected' : 'idle')),
            ),
          ),
        ),
      ) : null,
    ),
    // RIGHT: the form for the selected channel.
    h('div', { style: { flex: '1 1 auto', minWidth: '0' } },
      // --- placeholder guide ---
      guideOnly && guide
        ? h('div', { style: {
          border: '1px dashed rgba(128,128,128,0.4)', borderRadius: '10px', padding: '16px',
        } },
          h('div', { style: { fontWeight: 600, marginBottom: '8px' } },
            channelLabel((creating as ChannelType) ?? (active?.type as ChannelType))),
          h('p', { style: { fontSize: '13px', lineHeight: 1.6 } }, t('placeholder.note')),
          h('p', { style: { fontSize: '13px', lineHeight: 1.6, marginTop: '8px' } }, t('type.' + (creating as ChannelType ?? active?.type) + '.desc')),
          h('a', { href: guide, target: '_blank', rel: 'noreferrer', style: { display: 'inline-block', marginTop: '10px', color: '#4f8cff' } },
            t('placeholder.open') + ' →'),
        )
        // --- live form ---
        : h('div', null,
          notice !== '' ? h('div', { style: { color: '#57d18a', fontSize: '12px', marginBottom: '8px' } }, notice) : null,
          creating !== null || active
            ? h('div', { style: { display: 'grid', gap: '12px' } },
                h('div', { style: { display: 'grid', gap: '4px' } },
                  h('label', { style: { fontSize: '12px', opacity: 0.75 } }, t('field.name')),
                  h('input', {
                    value: draftName,
                    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraftName(e.target.value),
                    style: inputStyle,
                  }),
                ),
                ...activeFields.map(f =>
                  h('div', { key: f.key, style: { display: 'grid', gap: '4px' } },
                    h('label', { style: { fontSize: '12px', opacity: 0.75 } }, t(f.labelKey)
                      + (f.secret && activeSecretSet ? ` (${t('credential.set')})` : '')),
                    h('input', {
                      type: f.secret ? 'password' : 'text',
                      placeholder: f.secret && activeSecretSet ? t('credential.placeholder.isSet') : '',
                      value: draft[f.key] ?? '',
                      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
                        setDraft(prev => ({ ...prev, [f.key]: e.target.value })),
                      style: inputStyle,
                    }),
                  ),
                ),
                h('div', { style: { display: 'flex', gap: '10px', marginTop: '4px' } },
                  h('button', { type: 'button', onClick: () => void save(), disabled: busy, style: primaryStyle },
                    t('channels.save')),
                  active ? h('button', { type: 'button', onClick: () => void remove(active.id), disabled: busy,
                    style: { ...ghostStyle, color: '#ff7a7a' } }, t('channels.delete')) : null,
                ),
              )
            : h('p', { style: { opacity: 0.7, fontSize: '14px' } }, t('channels.empty')),
        ),
    ),
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px',
  border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', fontSize: '13px',
}

const primaryStyle: React.CSSProperties = {
  padding: '8px 18px', borderRadius: '8px', border: 'none', background: '#4f8cff', color: '#fff',
  fontSize: '13px', cursor: 'pointer', fontWeight: 600,
}

const ghostStyle: React.CSSProperties = {
  padding: '8px 18px', borderRadius: '8px', border: '1px solid rgba(128,128,128,0.35)',
  background: 'transparent', fontSize: '13px', cursor: 'pointer',
}
