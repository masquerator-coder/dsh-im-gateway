/**
 * Multi-channel IM gateway configuration schema (HOST half only).
 *
 * One channel RECORD is stored per configured channel. SECRET fields are
 * declared with `role('secret')`: the framework redacts them on every wire
 * boundary (so they are never returned to the client), yet the host still reads
 * them back from its own live Config — which is how the transports obtain
 * apiKeys / passwords / tokens.
 *
 * HISTORY: this used to be a standalone `im-channels` settings NAMESPACE
 * registered with `settings.register(ns, schema)`. DSH 0.1.7 removed that API
 * and replaced it with volatile fields on the plugin's own Config, so the record
 * schema below is now composed directly into `Config.channels` (see
 * ../config.ts). `CHANNEL_TYPES` is still the single source of truth for the
 * kinds the gateway can manage.
 *
 * DSH's vendored schemastery has NO `.optional()` — optional fields are
 * declared with `.required(false)`; `.required()` marks a field mandatory.
 */

import z from '@deepseek-ai/schemastery'
import type { ChannelType } from './types.ts'

/** The channel kinds the gateway can manage. */
export const CHANNEL_TYPES: readonly ChannelType[] = [
  'wechat', 'qq', 'email', 'cmcc', 'feishu', 'http',
]

const SECRET = (): z<any> => z.string().required(false).role('secret')

/** schemastery schema for ONE configured channel record. */
export const ChannelRecordSchema = z.object({
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
    maxTokens: z.number().required(false),
    allowlist: z.array(z.string()).required(false),

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

    // wechat (official ilink gateway)
    baseUrl: z.string().required(false),
    token: SECRET(),

    // qq (official bot; appId/appSecret shared with feishu above)
    botApiBase: z.string().required(false),
    sandbox: z.boolean().required(false),
    /**
     * Event subscription for the QQ gateway: a decimal bitmask or keywords
     * (`c2c,public_guild`). Empty = the built-in default. Only `public_guild`
     * (and `guilds`/`guild_members`) are granted by default on q.qq.com; asking
     * for anything else before approval makes the gateway close the connection.
     */
    intents: z.string().required(false),
})

export type { ChannelConfig, ChannelStatus, ChannelType, ChannelsSettings } from './types.ts'
