import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { boundContextSummary, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { sessionIdForChat } from './session.ts'

/**
 * Per-message runtime options, resolved from the channel that received it
 * (agent routing can differ from one IM channel to the next).
 */
export interface MessageRuntime {
  /** Optional provider route override for the created agent. */
  provider?: string
  /** Optional model id override. */
  model?: string
  /** Optional positive output-token cap. */
  maxTokens?: number
  /** Optional working directory for the agent session. */
  cwd?: string
  /** Optional agent preset. */
  agentPreset?: string
  /** Whether to dispose the agent right after its reply is delivered. */
  disposeAfterReply?: boolean
}

/** A function the transport supplies to push one agent reply back out. */
export type ReplySink = (text: string) => Promise<void>

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

export interface AgentRouting {
  provider?: string
  model?: string
  maxTokens?: number
  cwd?: string
  agentPreset?: string
}

/**
 * One gateway instance: maps external chats to persistent agents, injects
 * inbound messages and routes each collected reply back through the per-message
 * `ReplySink` that the receiving transport supplied. This decouples the agent
 * plumbing (common to every channel) from the transport (per channel).
 */
export class ImGateway {
  private readonly agents = new Map<SessionId, AgentHandle>()
  private readonly pending = new Map<SessionId, ReplyCollector>()

  constructor(
    private readonly ctx: Context,
    private readonly defaults: AgentRouting = {},
  ) {
    // Observe every reply across the runtime and forward matching runs.
    ctx.on('session/event', (session, event) => {
      this.onSessionEvent(session, event)
    })
  }

  /**
   * Handle one inbound IM message: inject it into the persistent agent for the
   * external chat (creating the agent on first contact), then deliver the reply
   * back through `reply`.
   */
  async handle(message: InboundMessage, reply: ReplySink, runtime: MessageRuntime = {}): Promise<void> {
    const { chatId, text } = message
    const sessionId = SessionId(sessionIdForChat(chatId))
    let handle = this.agents.get(sessionId)
    if (handle === undefined) {
      handle = await this.ensureAgent(sessionId, runtime)
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
    void this.awaitReply(sessionId, collector, reply, runtime)
  }

  /**
   * Resolve the provider + model for a created agent: explicit per-channel
   * runtime values win; otherwise fall back to the deployment default model
   * selection (`agentDefaultModel.currentSelection()`), matching how DSH's own
   * headless/session-controller create agents. Without a model the persona
   * template variable `{{model}}` renders with no value and the first turn
   * errors out with no reply — this fallback is what prevents that.
   */
  private resolveModel(runtime: MessageRuntime): { provider?: string; model?: string } {
    if (runtime.provider || runtime.model) {
      return {
        ...(runtime.provider ? { provider: runtime.provider } : {}),
        ...(runtime.model ? { model: runtime.model } : {}),
      }
    }
    const selection = this.ctx.get('agentDefaultModel')?.currentSelection()
    return {
      ...(selection?.provider ? { provider: selection.provider } : {}),
      ...(selection?.model ? { model: selection.model } : {}),
    }
  }

  /** Create (and remember) the persistent agent for one external chat. */
  private async ensureAgent(sessionId: SessionId, runtime: MessageRuntime): Promise<AgentHandle> {
    const model = this.resolveModel(runtime)
    const selection: ModelSelection | undefined = (model.provider && model.model)
      ? { provider: model.provider, model: model.model }
      : undefined
    // The agent-scoped model selection must be *installed* (not just passed as
    // an option): installModelSelection wires the selected provider/model into
    // both `system-prompt/assemble` (so a persona's `{{model}}` renders) and
    // `agent/request` (so the LLM call actually routes to that provider). Without
    // it the im agent runs with no model — the persona renders `{{model}}` empty
    // and the first turn ends with zero tokens and no reply. This mirrors how
    // DSH's own headless and session-controller create agents with the default
    // model selection.
    const modelRef: ModelSelectionRef = { current: selection, assembled: undefined }
    const options: AgentOptions = {
      ...(model.provider ? { provider: model.provider } : {}),
      ...(model.model ? { model: model.model } : {}),
      ...(runtime.maxTokens ? { maxTokens: runtime.maxTokens } : {}),
    }
    const cwdSet = runtime.cwd !== undefined && runtime.cwd !== ''
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: {
        ...(cwdSet ? { cwd: runtime.cwd } : {}),
        ...(runtime.agentPreset ? { agentPreset: runtime.agentPreset } : {}),
      },
      ...(Object.keys(options).length > 0 ? { agentOptions: options } : {}),
      setup: (agentCtx) => {
        installModelSelection(agentCtx, modelRef)
        // Optional preset mount (only when explicitly configured).
      },
    })
    this.ctx.logger.info(
      `[im-gateway] created agent ${sessionId}`
        + (selection ? ` (model=${selection.provider}/${selection.model})` : ' (no default model!)'),
    )
    return handle
  }

  /** Wait for the collector to settle, then forward the reply through the sink. */
  private async awaitReply(
    sessionId: SessionId,
    collector: ReplyCollector,
    reply: ReplySink,
    runtime: MessageRuntime,
  ): Promise<void> {
    try {
      await collector.agent.whenIdle()
      const text = collector.settle()
      this.pending.delete(sessionId)
      if (text !== '') {
        await reply(text)
      } else {
        this.ctx.logger.warn(`[im-gateway] empty reply for ${sessionId}`)
      }
    } catch (error: unknown) {
      collector.settle()
      this.pending.delete(sessionId)
      this.ctx.logger.warn(`[im-gateway] reply for ${sessionId} failed: ${errorChain(error)}`)
    } finally {
      if (runtime.disposeAfterReply) {
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
