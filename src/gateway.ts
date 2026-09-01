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

/**
 * Safety bound on one reply turn. The inbound HTTP server acks (202) only after
 * `gateway.handle()` resolves, so a reply wait MUST always terminate — the
 * global `session/event` mux settles on `turn/end`, and this timeout is the
 * fallback that guarantees the ack goes out even if the agent drops the turn.
 */
const REPLY_TIMEOUT_MS = 300_000

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
  /** Disposer for the global `session/event` mux; cleared on close(). */
  private readonly offSessionEvent: () => void

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
  }

  /** Handle one inbound IM message and deliver the collected reply via `reply`. */
  async handle(message: InboundMessage, reply: ReplySink, runtime: MessageRuntime = {}): Promise<void> {
    const { chatId, text } = message
    const sessionId = SessionId(sessionIdForChat(chatId))
    let handle = this.agents.get(sessionId)
    if (handle === undefined) {
      handle = await this.ensureAgent(sessionId, runtime)
      this.agents.set(sessionId, handle)
    }

    const wait = new ReplyWaiter(sessionId, randomUUID())
    this.waiters.set(sessionId, wait)

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      // A `user` MessageSource carries `{ kind: 'user' }` plus optional opaque
      // provenance fields in the merge-extensible runtime type. The `rpcId`
      // lets the global session/event collector claim exactly this prompt's
      // turn and assemble its assistant reply (mirrors dsh-im-main).
      source: { kind: 'user', rpcId: wait.promptRpcId } as unknown as MessageSource,
    }))

    await this.awaitReply(sessionId, wait, reply, runtime)
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
        await reply(text)
      } else {
        this.ctx.logger.warn(`[im-gateway] empty reply for ${sessionId}`)
      }
    } catch (error: unknown) {
      wait.settle()
      this.waiters.delete(sessionId)
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
  }
}

/** Read the session id from either the runtime's Session, its handle, or the raw session value. */
function sessionIdOf(session: unknown): SessionId | undefined {
  const s = session as { id?: string; sessionId?: string }
  if (s?.id) return SessionId(s.id)
  if (s?.sessionId) return SessionId(s.sessionId)
  return undefined
}
