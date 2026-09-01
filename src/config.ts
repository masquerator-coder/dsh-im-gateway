import Schema from '@deepseek-ai/schemastery'

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
}

export const Config: Schema<Config> = Schema.object({
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
})
