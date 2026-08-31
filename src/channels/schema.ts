/**
 * Multi-channel IM gateway configuration schema (HOST half only).
 *
 * A single settings namespace `im-channels` stores the NON-secret wiring for
 * every channel. Secrets (apiKey, SMTP/IMAP passwords, callback secrets…)
 * NEVER live here: they are stored through the Host `credentials` channel and
 * `role('secret')` fields are redacted on every wire boundary.
 *
 * This file is host-only because it value-imports schemastery; the browser
 * half consumes the pure types from `./types.ts` instead.
 *
 * DSH's vendored schemastery has NO `.optional()` — optional fields are
 * declared with `.required(false)` (see vendor/schemastery/src/index.ts:
 * `Schema.required(value?)`); `.required()` marks a field mandatory.
 */

import z from '@deepseek-ai/schemastery'
import type { ChannelType, ChannelsSettings } from './types.ts'

/** Settings namespace owned by this plugin (host-side registration). */
export const CHANNELS_NS = 'im-channels'

/** The channel kinds the gateway can manage. */
export const CHANNEL_TYPES: readonly ChannelType[] = [
  'wechat', 'qq', 'email', 'cmcc', 'feishu', 'http',
]

/** schemastery schema for the `im-channels` namespace. */
export const ChannelsSettingsSchema: z<ChannelsSettings> = z.object({
  channels: z.array(z.object({
    id: z.string().required(),
    type: z.union([...CHANNEL_TYPES]).required(),
    name: z.string().required(),
    enabled: z.boolean().required(false).default(false),
    note: z.string().required(false),

    // email
    host: z.string().required(false),
    imapPort: z.number().required(false),
    smtpPort: z.number().required(false),
    useTls: z.boolean().required(false),
    account: z.string().required(false),

    // cmcc
    serverUrl: z.string().required(false),
    uploadUrl: z.string().required(false),
    version: z.string().required(false),

    // http
    inboundPath: z.string().required(false),
    chatIdField: z.string().required(false),
    textField: z.string().required(false),
    callbackUrl: z.string().required(false),
    callbackChatHeader: z.string().required(false),

    // base
    provider: z.string().required(false),
    model: z.string().required(false),
    cwd: z.string().required(false),
    agentPreset: z.string().required(false),
  })).default([]),
})

export type { ChannelConfig, ChannelStatus, ChannelType, ChannelsSettings } from './types.ts'
