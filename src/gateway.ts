import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage, errorChain, type MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { sessionIdForChat } from './session.ts'
import { InteractionBridge } from './interaction.ts'

/**
 * Safety bound on one reply turn. The inbound HTTP server acks (202) as soon as
 * the message is accepted (see `inbound.ts`), so the caller does not block on
 * the model turn — but the reply-wait that runs in the background MUST always
 * terminate: the global `session/event` mux settles on `turn/end`, and this
 * timeout is the fallback that guarantees the collected reply is delivered (or
 * explicitly dropped with "NOT delivered") even if the agent never emits a
 * matching `turn/end`.
 */
const REPLY_TIMEOUT_MS = 300_000

/**
 * Inbound de-duplication window: suppresses a platform replay/echo of the same
 * chat + text arriving again within this window so a duplicate never
 * double-triggers a model turn.
 */
const DEDUP_WINDOW_MS = 5_000

/** Bounded retries (total delivery attempts) for one reply over a flaky channel. */
const REPLY_DELIVERY_MAX_ATTEMPTS = 2

/** Per-message routing options resolved from the channel that received it. */
export interface MessageRuntime {
  /** Optional provider route override for the created agent. */
  provider?: string
  /** Optional model id override. */
  model?: string
  /** Optional positive output-token cap. */
  maxTokens?: number
  /** Optional working directory for the agent session (a real Harness workspace). */
  cwd?: string
  /** Optional agent preset label. */
  agentPreset?: string
  /** Optional human-readable session title shown in the web UI. */
  title?: string
  /** Whether to dispose the agent right after its reply is delivered. */
  disposeAfterReply?: boolean
  /**
   * Receiving channel/bot identity, folded into the session key so two channels
   * (or bots) with the same external chat id never share a session. Filled by
   * each transport (cmcc/email/...), defaults to the gateway-level channel.
   */
  channel?: string
}

/** A function transport supplies to push one agent reply back out. */
export type ReplySink = (text: string) => Promise<void>

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
  title?: string
  /** Default channel/bot identity used when a runtime doesn't supply one. */
  channel?: string
  /**
   * Sender allowlist (access control). Non-empty ⇒ only these senderIds may
   * drive the agent; others (or sender-less messages) are denied up front.
   */
  allowlist?: string[]
}

/** Render an assistant message's text blocks into one reply string. */
function textOf(event: Extract<SessionEvent, { type: 'assistant/message' }>): string {
  return event.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Resolve after `ms`, tagging the outcome so a caller can distinguish timeout from a settled turn. */
function timeout(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => { setTimeout(() => resolve('timeout'), ms) })
}

/** Resolve after `ms`, used for bounded delivery-retry backoff. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * One in-flight reply: claims the turn opened by the user message identified by
 * `promptRpcId`, accumulates that turn's assistant text, and settles on its
 * `turn/end`. Turn tracking mirrors how DSH's own harness client distills one
 * prompt's reply from the global session event stream. `done` resolves exactly
 * when the owned turn ends — the event-mux drives settlement (rpcId claiming is
 * race-immune), not an `agent.whenIdle()` poll.
 */
class ReplyWaiter {
  private readonly parts: string[] = []
  private owned = false
  private openTurn = -1
  private closed = false

  /** Resolves when this waiter settles on its owned `turn/end`. */
  readonly done: Promise<void>
  private resolveDone!: () => void

  constructor(
    readonly sessionId: SessionId,
    readonly promptRpcId: string,
  ) {
    this.done = new Promise((resolve) => { this.resolveDone = resolve })
  }

  /** Observe one session event; returns true once this waiter is settled. */
  observe(event: SessionEvent): boolean {
    if (this.closed) return true
    switch (event.type) {
      case 'turn/start':
        this.openTurn = event.data?.turn ?? -1
        return false
      case 'user/message':
        // The pinned dsh-agent `user` source is closed to `{ kind: 'user' }`,
        // but dsh's MessageSource is merge-extensible at runtime: the rpcId we
        // attach to the user message is persisted/emitted verbatim, and the
        // harness's own client claims turns by it (dsh-im-main 同款逻辑).
        if ((event.data?.source as { rpcId?: string } | undefined)?.rpcId === this.promptRpcId) this.owned = true
        return false
      case 'assistant/message':
        if (this.owned) this.parts.push(textOf(event))
        return false
      case 'turn/end':
        if (this.owned && event.data?.turn === this.openTurn) {
          this.finish()
          return true
        }
        return false
      default:
        return false
    }
  }

  /** Force-close this waiter (timeout / caller teardown) and return what is accumulated so far. */
  settle(): string {
    this.finish()
    return this.parts.join('')
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.resolveDone()
  }
}

/** Minimal structural type for a Harness workspace entity (dynamic service, no static dep). */
interface WorkspaceEntity {
  path: string
  attachSession(sessionId: SessionId): Promise<void>
}

/** Minimal structural type for the workspace registry service. */
interface WorkspaceRegistry {
  list(): readonly WorkspaceEntity[]
  create(path: string, title?: string): Promise<WorkspaceEntity>
}

/** Base directory for IM sessions when no explicit workspace `cwd` is configured. */
function defaultWorkspaceDir(): string {
  return join(homedir(), '.dsh', 'im-workspace')
}

/**
 * One gateway instance: maps external chats to persistent Harness sessions and
 * routes each collected reply back through the per-message `ReplySink` the
 * receiving transport supplied.
 *
 * Sessions are created exactly like DSH's own webhook/session-controller path:
 * attached to a real Harness workspace, given the default (or per-channel)
 * agent preset, and pinned to the deployment default permission preset. This is
 * what makes the agent turn assemble a real model request and lets a stable
 * session id resume cleanly across restarts (no `_no-cwd` id collision).
 */
export class ImGateway {
  private readonly agents = new Map<SessionId, AgentHandle>()
  private readonly waiters = new Map<SessionId, ReplyWaiter>()
  private readonly workspaces = new Map<string, WorkspaceEntity>()
  /** In-flight workspace provision promises (dedups concurrent ensureWorkspace calls). */
  private readonly workspaceInFlight = new Map<string, Promise<WorkspaceEntity | undefined>>()
  /** Disposer for the global `session/event` mux; cleared on close(). */
  private readonly offSessionEvent: () => void
  /** Per-session tail promises, serializing concurrent messages for one chat. */
  private readonly tails = new Map<SessionId, Promise<void>>()
  /** Recent-message dedup key → first-seen timestamp. */
  private readonly recent = new Map<string, number>()
  /** Per-session outbound senders, populated per inbound route so IM-side
   *  approval/question prompts can be pushed down the same channel that drives
   *  that session. Keyed by session id; set by `registerSender`. */
  private readonly senders = new Map<string, (text: string) => Promise<void>>()
  /** IM-only bridge for DSH approval / user-question seams. */
  readonly interactions: InteractionBridge

  constructor(
    private readonly ctx: Context,
    private readonly defaults: AgentRouting = {},
  ) {
    // `global: true` mirrors the webhook/session-controller: receive session
    // events regardless of Cordis binding so an agent created here can always
    // claim its turns. The returned disposer is kept for close() cleanup.
    this.offSessionEvent = ctx.on('session/event', (_session, event: SessionEvent) => {
      this.onSessionEvent(_session, event)
    }, { global: true })
    this.interactions = new InteractionBridge(ctx)
  }

  /**
   * Register the outbound sender for one session (called by the channel manager
   * on every inbound route). Used to push approval/question prompts down the
   * chat's IM channel. The latest sender wins; lookup happens at call time.
   */
  registerSender(sessionId: string, sender: (text: string) => Promise<void>): void {
    this.senders.set(sessionId, sender)
  }

  /**
   * Handle one inbound IM message and deliver the collected reply via `reply`.
   *
   * Order of gates, before any agent/workspace/model side effect:
   * 1. sender allowlist (access control, deny-by-default when configured);
   * 2. inbound de-duplication (platform replay/echo suppression);
   * 3. per-session serialization (at most one in-flight turn per chat so
   *    concurrent messages can't overwrite each other's reply claim).
   */
  async handle(message: InboundMessage, reply: ReplySink, runtime: MessageRuntime = {}): Promise<void> {
    const channel = runtime.channel ?? this.defaults.channel
    if (!this.allowSender(message)) {
      this.ctx.logger.warn(`[im-gateway] denied message chat=${message.chatId} sender=${message.senderId ?? '(none)'}`)
      return
    }
    if (this.isRecentDuplicate(message, channel)) {
      this.ctx.logger.info(`[im-gateway] suppressed duplicate chat=${message.chatId} sender=${message.senderId ?? '(none)'}`)
      return
    }
    // Fold the receiving channel into the session key so the same external
    // chat id on different channels never shares a session (isolation).
    const sessionId = SessionId(sessionIdForChat(message.chatId, channel ?? ''))
    // Keep the outbound sender hot for this session so an in-flight approval /
    // question prompt can be pushed down the same channel that drives it.
    this.registerSender(String(sessionId), reply)
    // If this inbound text answers an outstanding IM-side approval/question,
    // settle it and do NOT feed the text to the agent as a normal message.
    if (this.interactions.consume(String(sessionId), message.text).consumed) {
      this.ctx.logger.info(`[im-gateway] consumed interaction reply for ${sessionId}`)
      return
    }
    const prev = this.tails.get(sessionId) ?? Promise.resolve()
    const run = prev
      .then(() => this.process(sessionId, message, reply, runtime, channel))
      .catch((error: unknown) => {
        this.ctx.logger.warn(`[im-gateway] handle ${sessionId} failed: ${errorChain(error)}`)
      })
    this.tails.set(sessionId, run.finally(() => {
      if (this.tails.get(sessionId) === run) this.tails.delete(sessionId)
    }))
    await run
  }

  /** The body of one turn: ensure agent, claim the turn, follow up, collect reply. */
  private async process(
    sessionId: SessionId,
    message: InboundMessage,
    reply: ReplySink,
    runtime: MessageRuntime,
    channel?: string,
  ): Promise<void> {
    let handle = this.agents.get(sessionId)
    if (handle === undefined) {
      handle = await this.ensureAgent(sessionId, runtime)
      this.agents.set(sessionId, handle)
    }

    const wait = new ReplyWaiter(sessionId, randomUUID())
    this.waiters.set(sessionId, wait)

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: this.composePrompt(message, channel) }],
      // A `user` MessageSource carries `{ kind: 'user' }` plus optional opaque
      // provenance fields in the merge-extensible runtime type. The `rpcId`
      // lets the global session/event collector claim exactly this prompt's
      // turn and assemble its assistant reply (mirrors dsh-im-main).
      source: { kind: 'user', rpcId: wait.promptRpcId } as unknown as MessageSource,
    }))

    await this.awaitReply(sessionId, wait, reply, runtime)
  }

  /** Sender access control: allow all when no allowlist, else deny-by-default. */
  private allowSender(message: InboundMessage): boolean {
    const allow = this.defaults.allowlist
    if (allow === undefined || allow.length === 0) return true
    if (message.senderId === undefined || message.senderId === '') return false
    return allow.includes(message.senderId)
  }

  /** Suppress identical chat+text replays/echoes within the dedup window. */
  private isRecentDuplicate(message: InboundMessage, channel?: string): boolean {
    const key = `${channel ?? ''}|${message.chatId}|${message.text}`
    const now = Date.now()
    const first = this.recent.get(key)
    if (first !== undefined && now - first < DEDUP_WINDOW_MS) return true
    if (this.recent.size > 500) {
      for (const [k, t] of this.recent) {
        if (now - t >= DEDUP_WINDOW_MS) this.recent.delete(k)
      }
    }
    this.recent.set(key, now)
    return false
  }

  /** Prepend source metadata (⑤) so the model knows who/which channel asked. */
  private composePrompt(message: InboundMessage, channel?: string): string {
    const meta: Record<string, string> = {}
    if (channel !== undefined && channel !== '') meta.channel = channel
    if (message.senderId !== undefined && message.senderId !== '') meta.senderId = message.senderId
    if (Object.keys(meta).length === 0) return message.text
    return `<dsh_im_source>${JSON.stringify(meta)}</dsh_im_source>\n\n${message.text}`
  }

  /** Resolve the provider + model: explicit per-channel values win, else the default model selection. */
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

  /** Create a persistent session for one external chat, workspace-attached and fully composed. */
  private async ensureAgent(sessionId: SessionId, runtime: MessageRuntime): Promise<AgentHandle> {
    const model = this.resolveModel(runtime)
    const selection: ModelSelection | undefined = (model.provider && model.model)
      ? { provider: model.provider, model: model.model }
      : undefined
    const modelRef: ModelSelectionRef = { current: selection, assembled: undefined }
    const options: AgentOptions = {
      ...(model.provider ? { provider: model.provider } : {}),
      ...(model.model ? { model: model.model } : {}),
      ...(runtime.maxTokens ? { maxTokens: runtime.maxTokens } : {}),
    }

    // A real Harness workspace (explicit cwd, else the IM default). Attaching
    // every session to one is what lets a stable id resume instead of colliding
    // with a persisted `_no-cwd` log.
    const workspacePath = runtime.cwd && runtime.cwd !== '' ? runtime.cwd : (this.defaults.cwd || defaultWorkspaceDir())
    const workspace = await this.ensureWorkspace(workspacePath)

    // Shared "webhook-aligned" composition for both create and resume. Resume
    // loads an existing persisted session; create mints a fresh one. Either way
    // the agent gets the same model selection + agent preset the web path uses.
    const setup = async (agentCtx: Context): Promise<void> => {
      installModelSelection(agentCtx, modelRef)
      const presets = this.ctx.get('agentPresets')
      if (presets !== undefined) {
        await presets.mount(agentCtx, runtime.agentPreset || undefined)
      }
      // Register IM-side answerers for approval / user-questions on this agent's
      // scope so a question surfaces on the driving IM channel instead of only
      // the web UI. `next()`-falls back when no sender is present.
      this.interactions.install(agentCtx, String(sessionId), (text) => this.sendInteractive(sessionId, text))
    }

    let handle: AgentHandle
    if (await this.sessionPersisted(sessionId)) {
      // Cross-restart continuation: the same stable id already has a persisted
      // log (under the workspace cwd now, not `_no-cwd`). `agents.create` would
      // collide with it, so resume through the factory instead — this is the
      // step that makes "重启可续" work without an id collision.
      this.ctx.logger.info(`[im-gateway] resuming agent ${sessionId} (workspace=${workspacePath})`)
      handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: options,
        setup,
      })
    } else {
      handle = await this.ctx.agents.create({
        sessionId,
        meta: {
          cwd: workspacePath,
          ...(runtime.agentPreset ? { agentPreset: runtime.agentPreset } : {}),
        },
        ...(Object.keys(options).length > 0 ? { agentOptions: options } : {}),
        setup,
      })
    }

    // Register the session under its workspace so resumed/created sessions keep
    // the same durable identity the workspace expects (mirrors webhook).
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(sessionId)
      } catch (error: unknown) {
        this.ctx.logger.warn(`[im-gateway] attach session ${sessionId} to workspace: ${errorChain(error)}`)
      }
    }

    // Pinning the effective permission preset and a stable title mirrors the
    // webhook/session-controller session bootstrap and gives the reply/UI a
    // recognizable surface.
    const permission = this.ctx.get('permissionPresets')
    if (permission !== undefined) {
      try {
        permission.set(handle.agent.session, permission.defaultPreset)
      } catch (error: unknown) {
        this.ctx.logger.warn(`[im-gateway] permission preset for ${sessionId}: ${errorChain(error)}`)
      }
    }
    const title = runtime.title || this.defaults.title || `IM ${sessionId}`
    const titles = this.ctx.get('sessionTitle')
    if (titles !== undefined && typeof titles.rename === 'function') {
      try {
        titles.rename(handle.agent.session, title)
      } catch (error: unknown) {
        this.ctx.logger.warn(`[im-gateway] title rename for ${sessionId}: ${errorChain(error)}`)
      }
    }

    this.ctx.logger.info(
      `[im-gateway] created agent ${sessionId} (workspace=${workspacePath})`
        + (selection ? ` model=${selection.provider}/${selection.model}` : ''),
    )
    return handle
  }

  /** Find or create the Harness workspace backing IM sessions. */
  private async ensureWorkspace(path: string): Promise<WorkspaceEntity | undefined> {
    const existingProvision = this.workspaceInFlight.get(path)
    if (existingProvision !== undefined) return existingProvision

    const provision = this.provisionWorkspace(path)
    this.workspaceInFlight.set(path, provision)
    try {
      return await provision
    } finally {
      // Drop the in-flight marker once settled so a later call can re-probe
      // (and so close() sees an empty map).
      this.workspaceInFlight.delete(path)
    }
  }

  private async provisionWorkspace(path: string): Promise<WorkspaceEntity | undefined> {
    const cached = this.workspaces.get(path)
    if (cached !== undefined) return cached
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined
    if (registry === undefined) {
      // No workspace registry in this host: sessions carry their cwd metadata
      // directly and Harness still routes models through `agent/request`.
      return undefined
    }
    // The workspace registry canonicalizes a path with `fs.realpath`, so the
    // directory must already exist (mirrors session-controller's createOrAdopt,
    // which mkdirs the cwd before composing the agent). Create it first.
    try {
      await mkdir(path, { recursive: true })
    } catch (error: unknown) {
      this.ctx.logger.warn(`[im-gateway] mkdir workspace ${path}: ${errorChain(error)}`)
    }
    const existing = registry.list().find((item) => item.path === path)
    const entity = existing ?? await registry.create(path)
    this.workspaces.set(path, entity)
    return entity
  }

  /**
   * Probe whether a stable id already has a persisted session so `ensureAgent`
   * can `resume` instead of `create` (which would collide). Mirrors the API
   * session-controller: `sessionQuery.observeSession` resolves for a live or
   * prepared session and throws `SESSION_QUERY_SESSION_NOT_FOUND` otherwise.
   * Returns false when the probe service is absent (host without session query)
   * so creation still proceeds as a fresh-session fallback.
   */
  private async sessionPersisted(sessionId: SessionId): Promise<boolean> {
    const query = this.ctx.get('sessionQuery') as { observeSession?(id: SessionId): Promise<unknown> } | undefined
    if (query === undefined || typeof query.observeSession !== 'function') return false
    try {
      const lease = await query.observeSession(sessionId)
      // Caller-owned lease: release it now — it was only an existence probe.
      const disposable = lease as { [Symbol.dispose]?: () => void } | undefined
      try { disposable?.[Symbol.dispose]?.() } catch { /* best-effort release */ }
      return true
    } catch (error: unknown) {
      if ((error as { code?: string })?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return false
      this.ctx.logger.warn(`[im-gateway] session probe ${sessionId}: ${errorChain(error)}`)
      return false
    }
  }

  /** Wait for the collected reply, then forward it through the sink. */
  private async awaitReply(
    sessionId: SessionId,
    wait: ReplyWaiter,
    reply: ReplySink,
    runtime: MessageRuntime,
  ): Promise<void> {
    try {
      // Settle on the owned turn/end driven by the global event mux. A timeout
      // guarantees the inbound HTTP 202 always returns even when an agent error
      // drops the turn without a matching `turn/end`.
      const outcome = await Promise.race([wait.done.then(() => 'done' as const), timeout(REPLY_TIMEOUT_MS)])
      if (outcome === 'timeout') {
        this.ctx.logger.warn(`[im-gateway] reply for ${sessionId} timed out after ${REPLY_TIMEOUT_MS}ms`)
      }
      const text = wait.settle()
      this.waiters.delete(sessionId)
      if (text !== '') {
        await this.deliverWithRetry(reply, text, sessionId)
      } else {
        this.ctx.logger.warn(`[im-gateway] empty reply for ${sessionId}`)
      }
    } catch (error: unknown) {
      wait.settle()
      this.waiters.delete(sessionId)
      this.ctx.logger.warn(`[im-gateway] reply for ${sessionId} failed: ${errorChain(error)}`)
    } finally {
      if (runtime.disposeAfterReply) {
        // Await the dispose (not fire-and-forget) so it fully completes before
        // this turn resolves and the next queued message for the same chat
        // starts — otherwise a resume/ensureAgent could race a half-finished
        // dispose of the same handle.
        await this.disposeAgent(sessionId)
      }
    }
  }

  /**
   * Push one reply through the sink with a bounded retry. Delivery failures are
   * never silent (④): every failed attempt is logged, and the final give-up is
   * explicitly marked "NOT delivered" so loss is observable by the operator.
   */
  private async deliverWithRetry(reply: ReplySink, text: string, sessionId: SessionId): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await reply(text)
        return
      } catch (error: unknown) {
        if (attempt >= REPLY_DELIVERY_MAX_ATTEMPTS) {
          this.ctx.logger.warn(`[im-gateway] reply NOT delivered for ${sessionId} after ${attempt} attempts: ${errorChain(error)}`)
          return
        }
        this.ctx.logger.warn(`[im-gateway] reply attempt ${attempt} failed for ${sessionId}: ${errorChain(error)}`)
        await delay(300 * attempt)
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

  /**
   * Push an interactive prompt (approval / question) down the session's IM
   * channel through the sender registered by the latest inbound route. Throws
   * when no sender is available so the bridge delegates to the next answerer.
   */
  private sendInteractive(sessionId: SessionId, text: string): Promise<void> {
    const sender = this.senders.get(String(sessionId))
    if (sender === undefined) {
      return Promise.reject(new Error(`no outbound sender for ${sessionId}`))
    }
    return sender(text)
  }

  /** Route every session event into the matching per-run reply waiter. */
  private onSessionEvent(session: unknown, event: SessionEvent): void {
    const sessionId = sessionIdOf(session)
    if (sessionId === undefined) return
    const wait = this.waiters.get(sessionId)
    if (wait === undefined) return
    if (wait.observe(event)) {
      // Settled on its owned turn/end; stop routing events to it.
      this.waiters.delete(sessionId)
    }
  }

  /** Dispose all live agents and drop the global event mux (called on plugin unload). */
  async close(): Promise<void> {
    try {
      this.offSessionEvent()
    } catch (error: unknown) {
      this.ctx.logger.warn(`[im-gateway] close session/event mux: ${errorChain(error)}`)
    }
    for (const handle of this.agents.values()) {
      try {
        await handle.dispose()
      } catch (error: unknown) {
        this.ctx.logger.warn(`[im-gateway] close dispose: ${errorChain(error)}`)
      }
    }
    this.agents.clear()
    this.waiters.clear()
    this.tails.clear()
    this.recent.clear()
    this.senders.clear()
    this.interactions.clear()
    this.workspaceInFlight.clear()
  }
}

/** Read the session id from either the runtime's Session, its handle, or the raw session value. */
function sessionIdOf(session: unknown): SessionId | undefined {
  const s = session as { id?: string; sessionId?: string }
  if (s?.id) return SessionId(s.id)
  if (s?.sessionId) return SessionId(s.sessionId)
  return undefined
}
