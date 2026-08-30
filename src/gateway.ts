import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { boundContextSummary, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config } from './config.ts'

/** A deterministic, stable SessionId derived from an external chat id. */
function sessionIdForChat(chatId: string): SessionId {
  const digest = createHash('sha1').update(chatId).digest('hex').slice(0, 16)
  return SessionId(`im-${digest}`)
}

/** Render an assistant message's text blocks into one reply string. */
function textOf(event: Extract<SessionEvent, { type: 'assistant/message' }>): string {
  return event.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Accumulate one reply run: collects streaming text until the agent settles. */
class ReplyCollector {
  private readonly parts: string[] = []
  private settled = false

  constructor(
    readonly agent: Agent,
    private readonly session: unknown,
  ) {}

  append(text: string): void {
    if (!this.settled) this.parts.push(text)
  }

  settle(): string {
    if (this.settled) return this.parts.join('')
    this.settled = true
    return this.parts.join('')
  }

  owns(session: unknown): boolean {
    return session === this.session
  }
}

export interface InboundMessage {
  chatId: string
  text: string
  senderId?: string
}

/**
 * One gateway instance: maps external chats to persistent agents, injects
 * inbound messages, collects replies and POSTs them to the callback URL.
 */
export class ImGateway {
  private readonly agents = new Map<SessionId, AgentHandle>()
  private readonly pending = new Map<SessionId, ReplyCollector>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {
    // Observe every reply across the runtime and forward matching runs.
    ctx.on('session/event', (session, event) => {
      this.onSessionEvent(session, event)
    })
  }

  /**
   * Handle one inbound IM message. It is injected into the persistent agent
   * for the external chat (creating the agent on first contact), and the
   * agent's reply is collected and POSTed to the configured callback URL.
   */
  async handle(message: InboundMessage): Promise<void> {
    const { chatId, text } = message
    const sessionId = sessionIdForChat(chatId)
    let handle = this.agents.get(sessionId)
    if (handle === undefined) {
      handle = await this.ensureAgent(sessionId)
      this.agents.set(sessionId, handle)
    }
    const agent = handle.agent

    // End any collector still waiting on the previous turn so it does not
    // swallow text belonging to the new turn.
    const previous = this.pending.get(sessionId)
    if (previous !== undefined) {
      previous.settle()
      this.pending.delete(sessionId)
    }

    const collector = new ReplyCollector(agent, agent.session)
    this.pending.set(sessionId, collector)

    const bundled = this.describeInbound(message)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'user',
        ...(bundled === undefined ? {} : { summary: bundled }),
      },
    }))
    void this.awaitReply(sessionId, chatId, collector)
  }

  /** Create (and remember) the persistent agent for one external chat. */
  private async ensureAgent(sessionId: SessionId): Promise<AgentHandle> {
    const options: AgentOptions = {
      ...(this.config.provider ? { provider: this.config.provider } : {}),
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(this.config.maxTokens > 0 ? { maxTokens: this.config.maxTokens } : {}),
    }
    const cwdSet = this.config.cwd !== ''
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: {
        ...(cwdSet ? { cwd: this.config.cwd } : {}),
        ...(this.config.agentPreset ? { agentPreset: this.config.agentPreset } : {}),
      },
      ...(Object.keys(options).length > 0 ? { agentOptions: options } : {}),
      setup: async (agentCtx) => {
        // Optional preset mount (only when explicitly configured).
      },
    })
    this.ctx.logger.info(`[im-gateway] created agent ${sessionId}`)
    return handle
  }

  /** Wait for the collector to settle, then forward the reply to the callback. */
  private async awaitReply(sessionId: SessionId, chatId: string, collector: ReplyCollector): Promise<void> {
    try {
      await collector.agent.whenIdle()
      const reply = collector.settle()
      this.pending.delete(sessionId)
      if (reply !== '') {
        await this.postReply(chatId, reply)
      } else {
        this.ctx.logger.warn(`[im-gateway] empty reply for chat ${chatId}`)
      }
    } catch (error: unknown) {
      collector.settle()
      this.pending.delete(sessionId)
      this.ctx.logger.warn(`[im-gateway] reply for chat ${chatId} failed: ${errorChain(error)}`)
    } finally {
      if (this.config.disposeAfterReply) {
        void this.disposeAgent(sessionId)
      }
    }
  }

  private async disposeAgent(sessionId: SessionId): Promise<void> {
    const handle = this.agents.get(sessionId)
    if (handle === undefined) return
    this.agents.delete(sessionId)
    try {
      await handle.dispose()
    } catch (error: unknown) {
      this.ctx.logger.warn(`[im-gateway] dispose ${sessionId} failed: ${errorChain(error)}`)
    }
  }

  /** POST the reply back to the configured callback URL. */
  private async postReply(chatId: string, reply: string): Promise<void> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [this.config.callbackChatHeader]: chatId,
    }
    if (this.config.secret !== '') {
      headers[this.config.callbackSecretHeader] = this.config.secret
    }
    const response = await fetch(this.config.callbackUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        chat_id: chatId,
        text: reply,
        ts: Date.now(),
      }),
    })
    if (!response.ok) {
      throw new Error(`callback returned ${response.status} ${response.statusText}`)
    }
  }

  /** Build an optional human-readable source summary for attribution. */
  private describeInbound(message: InboundMessage): string | undefined {
    const parts: string[] = [`IM message in ${message.chatId}`]
    if (message.senderId !== undefined && message.senderId !== '') {
      parts.push(`from ${message.senderId}`)
    }
    const summary = parts.join(', ')
    return boundContextSummary(summary)
  }

  /** Route session events into the matching pending collector. */
  private onSessionEvent(session: unknown, event: SessionEvent): void {
    if (event.type !== 'assistant/message') return
    for (const collector of this.pending.values()) {
      if (collector.owns(session)) collector.append(textOf(event))
    }
  }

  /** Dispose all live agents (called on plugin unload). */
  async close(): Promise<void> {
    for (const handle of this.agents.values()) {
      await handle.dispose()
    }
    this.agents.clear()
    this.pending.clear()
  }
}
