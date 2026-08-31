/**
 * Multi-channel IM gateway configuration schema (HOST half only).
 *
 * A single settings namespace `im-channels` stores the wiring for every
 * channel. SECRET fields are declared with `role('secret')`: the framework
 * redacts them on every wire boundary (so they are never returned to the
 * client), yet the host still reads them back directly from the settings
 * scope — which is how the transports obtain apiKeys / passwords / tokens.
 *
 * DSH's vendored schemastery has NO `.optional()` — optional fields are
 * declared with `.required(false)`; `.required()` marks a field mandatory.
 */

import z from '@deepseek-ai/schemastery'
import type { ChannelType, ChannelsSettings } from './types.ts'

/** Settings namespace owned by this plugin (host-side registration). */
export const CHANNELS_NS = 'im-channels'

/** The channel kinds the gateway can manage. */
export const CHANNEL_TYPES: readonly ChannelType[] = [
  'wechat', 'qq', 'email', 'cmcc', 'feishu', 'http',
]

const SECRET = (): z<any> => z.string().required(false).role('secret')

/** schemastery schema for the `im-channels` namespace. */
export const ChannelsSettingsSchema: z<ChannelsSettings> = z.object({
  channels: z.array(z.object({
    id: z.string().required(),
    type: z.union([...CHANNEL_TYPES]).required(),
    name: z.string().required(),
    enabled: z.boolean().required(false).default(false),
    note: z.string().required(false),

    // agent routing
    provider: z.string().required(false),
    model: z.string().required(false),
    cwd: z.string().required(false),
    agentPreset: z.string().required(false),
    disposeAfterReply: z.boolean().required(false),

    // email
    host: z.string().required(false),
    imapPort: z.number().required(false),
    smtpPort: z.number().required(false),
    useTls: z.boolean().required(false),
    account: z.string().required(false),
    inbox: z.string().required(false),
    password: SECRET(),

    // cmcc
    serverUrl: z.string().required(false),
    uploadUrl: z.string().required(false),
    version: z.string().required(false),
    apiKey: SECRET(),

    // http
    inboundPath: z.string().required(false),
    chatIdField: z.string().required(false),
    textField: z.string().required(false),
    senderField: z.string().required(false),
    callbackUrl: z.string().required(false),
    callbackChatHeader: z.string().required(false),
    secret: SECRET(),

    // feishu
    appId: z.string().required(false),
    appSecret: SECRET(),

    // wechat
    clawUrl: z.string().required(false),
    token: SECRET(),

    // qq
    qq: z.string().required(false),
    qqPassword: SECRET(),
  })).default([]),
})

export type { ChannelConfig, ChannelStatus, ChannelType, ChannelsSettings } from './types.ts'
