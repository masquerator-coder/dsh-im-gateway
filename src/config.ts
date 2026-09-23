import Schema from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import type { ChannelConfig } from './channels/types.ts'
import { ChannelRecordSchema } from './channels/schema.ts'

/**
 * A channel record as handed back by a volatile reference: the config shape,
 * but recursively readonly (a `Volatile` snapshot is frozen).
 */
export type ReadonlyChannelConfig = Readonly<Omit<ChannelConfig, 'allowlist'>> & {
  readonly allowlist?: readonly string[]
}

/**
 * IM gateway configuration. Every tunable value flows through cordis.yml —
 * nothing is hardcoded (Harness configuration principle).
 */
export interface Config {
  /** Inbound HTTP listen address. */
  host: string
  /** Inbound HTTP listen port. */
  port: number
  /** URL path the webhook is served at, e.g. /im. */
  inboundPath: string
  /** Optional shared secret; requests must carry it in the `x-im-secret` header. Empty disables auth. */
  secret: string
  /** External webhook body field that identifies the chat (e.g. "chat_id"). */
  chatIdField: string
  /** External webhook body field that carries the message text. */
  textField: string
  /** Optional field carrying the sender id; appended to context for attribution. */
  senderField: string
  /**
   * Sender allowlist (access control). When non-empty, only these senderIds may
   * drive the agent; every other (or sender-less) message is denied BEFORE any
   * agent/workspace/model side effect. Empty disables per-sender authz.
   */
  allowlist: string[]
  /** Callback URL the agent's reply is POSTed to. */
  callbackUrl: string
  /** Callback request header name for the chat id (default x-im-chat-id). */
  callbackChatHeader: string
  /** Optional secret header sent with the callback (default x-im-secret). */
  callbackSecretHeader: string
  /** Model provider route for created agents. */
  provider: string
  /** Model id for created agents. */
  model: string
  /** Optional positive output-token cap. */
  maxTokens: number
  /** Optional agent preset applied to created agents. */
  agentPreset: string
  /** Optional working directory for the agent session. */
  cwd: string
  /** Whether idle agents are disposed after their last reply (free resources). */
  disposeAfterReply: boolean

  // ---- live multi-channel settings (VOLATILE) ----
  // DSH 0.1.7 replaced the plugin-registrable `settings.register(ns, schema)`
  // scope service with "profile-owned live Config + form projection": a plugin
  // now declares its own editable fields inline on its Config schema and marks
  // them `.volatile()`. The framework then projects exactly those fields into
  // the Plugins page form and writes edits straight back into these references
  // WITHOUT remounting the plugin (see `loader/volatile-update`). There is no
  // longer any per-plugin settings namespace to register.
  /**
   * Plugin-wide default working directory. Used by every channel without its
   * own `cwd`; a channel's own value always wins.
   */
  channelsCwd: Volatile<string | undefined>
  /** Ordered list of configured channels. */
  channels: Volatile<readonly ReadonlyChannelConfig[] | undefined>
}

/**
 * Accepted INPUT shape of this plugin's configuration.
 *
 * The non-volatile fields are optional with defaults; the two volatile fields
 * carry the plain (unwrapped) value a user writes in the profile or the Plugins
 * page form. Declaring this separately from {@link Config} is the DSH-native
 * pattern (cf. `@deepseek-ai/dsh-agent-loop`): the schema is typed
 * `Schema<ConfigInput, Config>` so the framework maps a plain input onto a
 * resolved Config whose volatile fields are readable references.
 */
export interface ConfigInput {
  host?: string
  port?: number
  inboundPath?: string
  secret?: string
  chatIdField?: string
  textField?: string
  senderField?: string
  allowlist?: string[]
  callbackUrl: string
  callbackChatHeader?: string
  callbackSecretHeader?: string
  provider?: string
  model?: string
  maxTokens?: number
  agentPreset?: string
  cwd?: string
  disposeAfterReply?: boolean
  channelsCwd?: string
  channels?: ReadonlyChannelConfig[]
}

export const Config: Schema<ConfigInput, Config> = Schema.object({
  host: Schema.string().default('127.0.0.1'),
  port: Schema.number().default(8799),
  inboundPath: Schema.string().default('/im'),
  secret: Schema.string().default(''),
  chatIdField: Schema.string().default('chat_id'),
  textField: Schema.string().default('text'),
  senderField: Schema.string().default('sender_id'),
  allowlist: Schema.array(Schema.string()).default([]),
  callbackUrl: Schema.string().required(),
  callbackChatHeader: Schema.string().default('x-im-chat-id'),
  callbackSecretHeader: Schema.string().default('x-im-secret'),
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
  maxTokens: Schema.number().default(0),
  agentPreset: Schema.string().default(''),
  cwd: Schema.string().default(''),
  disposeAfterReply: Schema.boolean().default(false),
  channelsCwd: Schema.string().volatile(),
  channels: Schema.array(ChannelRecordSchema).volatile(),
}) as Schema<ConfigInput, Config>
