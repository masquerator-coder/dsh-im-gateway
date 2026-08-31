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
    id: z.string(),
    type: z.union([...CHANNEL_TYPES]),
    name: z.string(),
    enabled: z.boolean().default(false),
    note: z.string().optional(),

    // email
    host: z.string().optional(),
    imapPort: z.number().optional(),
    smtpPort: z.number().optional(),
    useTls: z.boolean().optional(),
    account: z.string().optional(),

    // cmcc
    serverUrl: z.string().optional(),
    uploadUrl: z.string().optional(),
    version: z.string().optional(),

    // http
    inboundPath: z.string().optional(),
    chatIdField: z.string().optional(),
    textField: z.string().optional(),
    callbackUrl: z.string().optional(),
    callbackChatHeader: z.string().optional(),

    // base
    provider: z.string().optional(),
    model: z.string().optional(),
    cwd: z.string().optional(),
    agentPreset: z.string().optional(),
  })).default([]),
})

export type { ChannelConfig, ChannelStatus, ChannelType, ChannelsSettings } from './types.ts'
