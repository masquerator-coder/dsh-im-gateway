/**
 * Right-hand panel of the "IM 通道" settings section (client half).
 *
 * Footproof config model: every channel kind ships a PREFILL TEMPLATE so fixed
 * items (server URLs, ports, paths, protocol versions) are already filled in —
 * the user only supplies the key/token/account (or scans a QR for QQ/wechat).
 * Secrets live inside the saved channel record (`role('secret')` schema) and
 * never come back over the wire, so on edit an empty secret field means "keep
 * the stored value".
 *
 * Live connection status is pulled from the host RPC namespace `imGateway`;
 * when the host lacks `ctx.remote` the panel falls back to static labels.
 *
 * Compiled with classic-JSX; types are intentionally loose (`any` on DSH
 * client faces) because the DSH client types are not resolvable outside the
 * DSH monorepo; the runtime API matches the verified contracts.
 */

import * as React from 'react'
import { createElement as h, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import {
  type ChannelConfig, type ChannelType,
} from '../channels/types.ts'

/** One editable field of a channel, keyed by the schema field name. */
interface Field {
  key: string
  labelKey: string
  secret?: boolean
  placeholder?: string
}

/** Email providers: choosing one auto-fills host / IMAP / SMTP / TLS. */
interface EmailProvider {
  id: string
  label: string
  host: string
  imapPort: number
  smtpPort: number
  useTls: boolean
}

const EMAIL_PROVIDERS: EmailProvider[] = [
  { id: 'custom', label: '自定义', host: '', imapPort: 993, smtpPort: 587, useTls: true },
  { id: 'qq', label: 'QQ 邮箱', host: 'imap.qq.com', imapPort: 993, smtpPort: 465, useTls: true },
  { id: '163', label: '网易 163', host: 'imap.163.com', imapPort: 993, smtpPort: 465, useTls: true },
  { id: 'gmail', label: 'Gmail', host: 'imap.gmail.com', imapPort: 993, smtpPort: 465, useTls: true },
  { id: 'outlook', label: 'Outlook', host: 'outlook.office365.com', imapPort: 993, smtpPort: 587, useTls: true },
  { id: 'wework', label: '企业微信邮箱', host: 'imap.exmail.qq.com', imapPort: 993, smtpPort: 465, useTls: true },
]

const DEFAULT_CLAWBOT_URL = 'http://127.0.0.1:9001'
const DEFAULT_CMCC_WSS = 'wss://5gvas01.cmicmaap.com/gtw-ai/openclaw/ws/msg'

/** Per-type prefill template + field list (the "傻瓜式" defaults). */
interface Template {
  defaults: Record<string, unknown>
  fields: Field[]
}

function emailFields(provider: EmailProvider): Field[] {
  const base: Field[] = [
    { key: 'account', labelKey: 'field.account', placeholder: 'you@example.com' },
    { key: 'password', labelKey: 'field.password', secret: true, placeholder: '授权码 / 密码' },
  ]
  // A custom server has no prefill: let the user type host + ports (傻瓜式 known
  // providers auto-fill these, so they are hidden unless "自定义" is chosen).
  if (provider.id === 'custom') {
    base.unshift(
      { key: 'host', labelKey: 'field.host', placeholder: 'imap.example.com' },
      { key: 'imapPort', labelKey: 'field.imapPort', placeholder: '993' },
      { key: 'smtpPort', labelKey: 'field.smtpPort', placeholder: '587' },
    )
  }
  return base
}

function templatesFor(): Record<ChannelType, Template> {
  const cmcc: Template = {
    defaults: { serverUrl: DEFAULT_CMCC_WSS, version: '2.0' },
    fields: [
      { key: 'apiKey', labelKey: 'field.apiKey', secret: true, placeholder: 'ak_… 或 app_…' },
      { key: 'serverUrl', labelKey: 'field.serverUrl' },
      { key: 'version', labelKey: 'field.version' },
    ],
  }
  const http: Template = {
    defaults: { inboundPath: '/im', chatIdField: 'chat_id', textField: 'text', senderField: 'sender_id' },
    fields: [
      { key: 'callbackUrl', labelKey: 'field.callbackUrl', placeholder: 'https://…/reply' },
      { key: 'inboundPath', labelKey: 'field.inboundPath' },
      { key: 'chatIdField', labelKey: 'field.chatIdField' },
      { key: 'textField', labelKey: 'field.textField' },
      { key: 'secret', labelKey: 'field.secret', secret: true },
    ],
  }
  const email: Template = {
    defaults: { imapPort: 993, smtpPort: 587, useTls: true },
    fields: emailFields(EMAIL_PROVIDERS[0]!),
  }
  const feishu: Template = {
    defaults: {},
    fields: [
      { key: 'appId', labelKey: 'field.appId', placeholder: 'cli_…' },
      { key: 'appSecret', labelKey: 'field.appSecret', secret: true },
    ],
  }
  const wechat: Template = {
    defaults: { clawUrl: DEFAULT_CLAWBOT_URL },
    fields: [
      { key: 'clawUrl', labelKey: 'field.clawUrl' },
      { key: 'token', labelKey: 'field.token', secret: true },
    ],
  }
  const qq: Template = {
    defaults: {},
    fields: [
      { key: 'qq', labelKey: 'field.qq', placeholder: '留空则扫码登录' },
      { key: 'qqPassword', labelKey: 'field.qqPassword', secret: true },
    ],
  }
  return { cmcc, http, email, feishu, wechat, qq }
}

export interface ChannelsSectionProps {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  scope: any
  /** Host status RPC namespace (may be null when host lacks ctx.remote). */
  imGateway: any
  t: (key: string) => string
}

export function ChannelsSection(props: ChannelsSectionProps): React.ReactElement {
  const { scope, imGateway, t } = props
  const TP = useMemo(() => templatesFor(), [])

  // Subscribe to the bound scope.
  const snapshot = useSyncExternalStore(
    useCallback((cb: () => void) => scope.subscribe(cb), [scope]),
    useCallback(() => scope.getSnapshot(), [scope]),
  )
  const channels: ChannelConfig[] = snapshot?.value?.channels ?? []

  const [activeId, setActiveId] = useState<string | undefined>(
    channels.length > 0 ? channels[0]!.id : undefined,
  )
  const [creating, setCreating] = useState<ChannelType | null>(null)
  const [provider, setProvider] = useState('custom')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [draftName, setDraftName] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  // Live status map: channelId -> { status, detail, qr } (pulled via RPC).
  const [status, setStatus] = useState<Record<string, { status: string; detail?: string; qr?: string }>>({})

  const resolvedActiveId: string | undefined = channels.some(ch => ch.id === activeId)
    ? activeId
    : channels[0]?.id
  const active = channels.find(ch => ch.id === resolvedActiveId)

  // QR for the currently displayed channel, from the live status RPC map.
  const activeQr = status[resolvedActiveId ?? '']?.qr

  // Poll live status from the host RPC (fallback: static).
  useEffect(() => {
    if (!imGateway || typeof imGateway.list !== 'function') return
    let alive = true
    const poll = async (): Promise<void> => {
      try {
        const list = await imGateway.list()
        if (!alive || !Array.isArray(list)) return
        const map: Record<string, { status: string; detail?: string; qr?: string }> = {}
        for (const it of list) map[it.id] = { status: it.status, detail: it.detail, qr: it.qr }
        setStatus(map)
      } catch { /* transient */ }
    }
    void poll()
    const timer = setInterval(() => void poll(), 3000)
    return () => { alive = false; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imGateway])

  // Fields for the current creation/selection.
  const currentType = (creating as ChannelType) ?? (active?.type as ChannelType)
  const template = TP[currentType]
  const activeSecretSet = active
    ? (template?.fields.some(f => f.secret && (active as unknown as Record<string, unknown>)[f.key] !== undefined))
    : false

  // Effect: (re)backfill the form when selecting/saving a channel.
  useEffect(() => {
    if (creating !== null) return
    if (!active || !template) return
    const loaded: Record<string, string> = {}
    for (const f of template.fields) {
      if (f.secret) continue
      const v = (active as unknown as Record<string, unknown>)[f.key]
      if (v !== undefined && v !== null) loaded[f.key] = String(v)
    }
    // Match an email provider from the saved host, if any.
    if (active.type === 'email' && active.host) {
      const p = EMAIL_PROVIDERS.find(p => p.host === active.host)
      setProvider(p ? p.id : 'custom')
    }
    setDraft(loaded)
    setDraftName(active.name ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, creating])

  const beginCreate = useCallback((type: ChannelType) => {
    const tp = TP[type]
    const d: Record<string, string> = {}
    for (const f of tp?.fields ?? []) {
      const v = tp.defaults[f.key]
      if (typeof v === 'string' && v !== '') d[f.key] = v
    }
    setCreating(type)
    setProvider('custom')
    setDraft(d)
    setDraftName(t('type.' + type))
    setNotice('')
  }, [TP, t])

  const select = useCallback((id: string) => {
    setActiveId(id)
    setCreating(null)
  }, [])

  /** Fields for the current type (email switches with provider selection). */
  const currentFields: Field[] = useMemo(() => {
    if (!currentType) return []
    if (currentType === 'email') {
      const p = EMAIL_PROVIDERS.find(x => x.id === provider) ?? EMAIL_PROVIDERS[0]!
      return emailFields(p)
    }
    return TP[currentType]?.fields ?? []
  }, [currentType, provider, TP])

  const save = useCallback(async (): Promise<void> => {
    setBusy(true)
    setNotice('')
    try {
      const id = creating !== null ? `ch-${Date.now().toString(36)}` : (active?.id ?? '')
      const prev = active
      const type = creating as ChannelType ?? (active?.type as ChannelType)
      const tp = TP[type]

      const nextChannel: Record<string, unknown> = {
        ...(prev ?? {}),
        id,
        type,
        name: draftName || t('type.' + type),
        enabled: true,
      }

      // Apply prefill defaults on create.
      if (creating !== null && tp) {
        for (const [k, v] of Object.entries(tp.defaults)) nextChannel[k] = v
      }
      // Apply provider-derived email servers.
      if (type === 'email') {
        const p = EMAIL_PROVIDERS.find(x => x.id === provider) ?? EMAIL_PROVIDERS[0]!
        if (p.host) {
          nextChannel.host = p.host
          nextChannel.imapPort = p.imapPort
          nextChannel.smtpPort = p.smtpPort
          nextChannel.useTls = p.useTls
        }
      }
      // Merge non-secret draft fields + non-empty secret fields.
      for (const f of currentFields) {
        const v = draft[f.key]
        if (v === undefined || v === '') {
          if (f.secret) continue // keep stored secret
          continue
        }
        nextChannel[f.key] = (f.key === 'imapPort' || f.key === 'smtpPort')
          ? Number(v)
          : v
      }
      // Other typed fields from defaults (ports/booleans) already set above.

      const nextList = creating !== null
        ? [...channels, nextChannel as unknown as ChannelConfig]
        : channels.map(c => (c.id === id ? (nextChannel as unknown as ChannelConfig) : c))
      await scope.set('channels', nextList)
      setActiveId(id)
      setCreating(null)
      setNotice(t('channels.saved'))
    } catch (error) {
      setNotice(`${t('channels.saveFailed')}: ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [creating, active, channels, draft, draftName, provider, currentFields, scope, t, TP])

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

  const typeLabel = (type: ChannelType): string => t('type.' + type)

  // Live status is only trustworthy when the host exposes the `imGateway` RPC
  // namespace. Without it (host lacks `ctx.remote`) we must not fall back to a
  // misleading "未连接"; show a static "已配置" instead.
  const liveStatus = !!(imGateway && typeof imGateway.list === 'function')

  const statusOf = (ch: ChannelConfig): string =>
    liveStatus ? (status[ch.id]?.status ?? 'idle') : 'configured'

  const statusLabel = (s: string): string => {
    switch (s) {
      case 'configured': return t('channels.status.configured')
      case 'connected': return t('channels.status.connected')
      case 'connecting': return t('channels.status.connecting')
      case 'error': return t('channels.status.error')
      default: return t('channels.status.idle')
    }
  }

  const activeStatusKey = liveStatus
    ? (active ? statusOf(active) : creating ? 'connecting' : 'idle')
    : 'configured'

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
            style: listButtonStyle,
          },
            h('span', null, typeLabel(type)),
          ),
        ),
      ),
      channels.length > 0 ? h('div', { style: { marginTop: '14px' } },
        h('div', { style: { fontSize: '12px', opacity: 0.7, marginBottom: '6px' } }, t('channels.existing')),
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
                typeLabel(ch.type) + ' · ' + statusLabel(statusOf(ch)) + (ch.enabled ? '' : ' · ' + t('channels.disabled'))),
            ),
          ),
        ),
      ) : null,
    ),
    // RIGHT: form for the selected channel.
    h('div', { style: { flex: '1 1 auto', minWidth: '0' } },
      notice !== '' ? h('div', { style: { color: '#57d18a', fontSize: '12px', marginBottom: '8px' } }, notice) : null,
      creating !== null || active
        ? h('div', { style: { display: 'grid', gap: '12px' } },
            // Status line
            h('div', { style: { fontSize: '12px', opacity: currentType ? 0.8 : 0.6 } },
              `${typeLabel(currentType)} · ${statusLabel(activeStatusKey)}`
              + (status[resolvedActiveId ?? '']?.detail ? ` — ${status[resolvedActiveId ?? '']!.detail}` : ''),
            ),
            h('div', { style: { display: 'grid', gap: '4px' } },
              h('label', { style: labelStyle }, t('field.name')),
              h('input', { value: draftName, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraftName(e.target.value), style: inputStyle }),
            ),
            // Email provider picker (only for email).
            currentType === 'email' ? h('div', { style: { display: 'grid', gap: '4px' } },
              h('label', { style: labelStyle }, t('field.provider')),
              h('select', {
                value: provider,
                onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setProvider(e.target.value),
                style: inputStyle,
              },
                EMAIL_PROVIDERS.map(p => h('option', { key: p.id, value: p.id }, p.label)),
              ),
            ) : null,
            // Fields
            ...currentFields.map(f =>
              h('div', { key: f.key, style: { display: 'grid', gap: '4px' } },
                h('label', { style: labelStyle }, t(f.labelKey)
                  + (f.secret && activeSecretSet ? ` (${t('credential.set')})` : '')),
                h('input', {
                  type: f.secret ? 'password' : 'text',
                  placeholder: f.placeholder ?? '',
                  value: draft[f.key] ?? '',
                  onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
                    setDraft(prev => ({ ...prev, [f.key]: e.target.value })),
                  style: inputStyle,
                }),
              ),
            ),
            // QR for QQ / wechat (scan-to-login). Shown live from the host RPC.
            (currentType === 'qq' || currentType === 'wechat') ? h('div', { style: { fontSize: '12px' } },
              activeQr
                ? h('div', { style: { display: 'grid', gap: '6px' } },
                    h('img', { src: activeQr, alt: 'QR', style: { width: '168px', height: '168px', borderRadius: '8px', border: '1px solid rgba(128,128,128,0.35)' } }),
                    h('a', { href: activeQr, target: '_blank', rel: 'noreferrer', style: { color: '#4f8cff' } }, t('channels.openQr')),
                  )
                : h('span', { style: { opacity: 0.75 } }, t('channels.qrHint')) ) : null,
            h('div', { style: { display: 'flex', gap: '10px', marginTop: '4px' } },
              h('button', { type: 'button', onClick: () => void save(), disabled: busy, style: primaryStyle }, t('channels.save')),
              active ? h('button', { type: 'button', onClick: () => void remove(active.id), disabled: busy,
                style: { ...ghostStyle, color: '#ff7a7a' } }, t('channels.delete')) : null,
            ),
          )
        : h('p', { style: { opacity: 0.7, fontSize: '14px' } }, t('channels.empty')),
    ),
  )
}

const listButtonStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center',
  border: '1px solid rgba(128,128,128,0.3)', borderRadius: '8px', background: 'transparent',
  color: 'inherit', padding: '8px 10px', fontSize: '13px', cursor: 'pointer', textAlign: 'left',
}
const labelStyle: React.CSSProperties = { fontSize: '12px', opacity: 0.75 }
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

export { EMAIL_PROVIDERS }
