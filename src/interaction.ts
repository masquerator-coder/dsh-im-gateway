/**
 * IM-side bridge for DSH interactive seams (approval + user questions).
 *
 * DSH's approval (`approval/request`) and user-question (`user-questions/request`)
 * are agent-scoped waterfall events. In a running web host the default answerers
 * are the browser halves (ui-approval / ui-user-questions), which present the
 * prompt on the Web UI — invisible to a user talking to the agent over an external
 * IM channel (5G message, email, …). With no IM-side answerer the question fails
 * closed (`unavailable`) or hangs until the gateway reply timeout, so an IM session
 * that needs approval gets stuck.
 *
 * This bridge fixes that by registering, on every agent this gateway creates, a
 * scoped answerer that pushes the question down the *same* IM channel that drives
 * that agent's session, waits for the user's textual reply, and maps it back to the
 * closed outcome / structured answer the seam expects.
 *
 * Safety contract (do not regress):
 * - The answerer only ever handles an agent this gateway owns (its listeners are
 *   only installed for agents `ImGateway` creates/resumes) and only when a
 *   same-session outbound sender is available. Anything else → `next()` so the
 *   web answerer (or the fail-closed default) keeps working unchanged.
 * - Every interaction is aborted by the request's own `AbortSignal`; an abort
 *   settles `'cancelled'` exactly like the core seam.
 * - Inbound text that matches a pending prompt is consumed as the answer and is
 *   NEVER re-fed to the agent as a normal conversational message. Non-matching
 *   text during a pending prompt is still forwarded as a normal message (we never
 *   swallow real user text).
 *
 * The event payloads are typed here structurally (mirroring the shapes declared by
 * `@deepseek-ai/dsh-user-approval/types` and `@deepseek-ai/dsh-user-questions/types`)
 * so this module stays dependency-light and needs no peer packages installed for
 * type-checking. At runtime the answerers are plain Cordis waterfall listeners on the
 * agent-scoped context the host already provides, so no seam service package is
 * required by this plugin either.
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * Local mirrors of the DSH seam event declarations so `agentCtx.on(...)` sees
 * these waterfall events as valid keys without loading the seam packages. The
 * signatures match `@deepseek-ai/dsh-user-approval/types` and
 * `@deepseek-ai/dsh-user-questions/types`; at runtime the host dispatches them
 * on the agent-scoped context.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'approval/request'(
      req: ApprovalRequestEvent,
      next: () => Promise<ApprovalOutcome>,
    ): Promise<ApprovalOutcome>
    'user-questions/request'(
      request: AskUserQuestionRequestEvent,
      next: () => Promise<AskUserQuestionAnswer>,
    ): Promise<AskUserQuestionAnswer>
  }
}

/** Mirror of `ApprovalOutcome` from dsh-user-approval. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Mirror of `ApprovalRequestEvent` from dsh-user-approval (consumed fields). */
interface ApprovalRequestEvent {
  readonly agent: unknown
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** Mirror of `AskUserQuestionRequestEvent` from dsh-user-questions (consumed fields). */
interface AskUserQuestionRequestEvent {
  readonly questions: AskUserQuestionItem[]
  readonly signal?: AbortSignal
}

/** Mirror of `AskUserQuestionItem` from dsh-user-questions. */
interface AskUserQuestionItem {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
}

/** Mirror of `AskUserQuestionAnswer` from dsh-user-questions. */
interface AskUserQuestionAnswer {
  readonly answers: readonly AskUserQuestionAnswerItem[]
}

/** Mirror of `AskUserQuestionAnswerItem` from dsh-user-questions. */
interface AskUserQuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** One outstanding interaction awaiting a user reply on an IM channel. */
interface PendingRecord {
  kind: 'approval' | 'question'
  /** Send one textual prompt down the owning IM channel. */
  send: (text: string) => Promise<void>
  /** Try to interpret inbound user text as an answer. Returns true when consumed. */
  tryAnswer: (text: string) => boolean
  /** Abort the wait (request.signal fired / teardown). */
  abort: () => void
}

/** Pending interactions keyed by session id (at most one outstanding per session). */
export class InteractionBridge {
  private readonly pending = new Map<string, PendingRecord>()

  constructor(private readonly ctx: Context) {}

  /** True when `sessionId` has an outstanding interaction awaiting a reply. */
  has(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /**
   * Consume an inbound message if it answers the outstanding interaction.
   * Returns `{ consumed: true }` when matched-and-settled; otherwise `{ consumed: false }`
   * so the caller keeps routing it into the agent as a normal message.
   */
  consume(sessionId: string, text: string): { consumed: boolean } {
    const record = this.pending.get(sessionId)
    if (record === undefined) return { consumed: false }
    if (!record.tryAnswer(text.trim())) return { consumed: false }
    // `tryAnswer` settled the outcome; drop the record so later messages are normal.
    this.pending.delete(sessionId)
    return { consumed: true }
  }

  /** Abort + clear outstanding interaction(s). */
  clear(sessionId?: string): void {
    if (sessionId !== undefined) {
      this.pending.get(sessionId)?.abort()
      this.pending.delete(sessionId)
      return
    }
    for (const id of [...this.pending.keys()]) {
      this.pending.get(id)?.abort()
      this.pending.delete(id)
    }
  }

  /**
   * Register the agent-scoped answerers. Call inside `setup(agentCtx)` of every
   * agent this gateway creates/resumes. `sessionId` is the owning session and
   * `send` pushes a prompt down that chat's IM channel.
   *
   * Listeners are bound to `agentCtx`, so they are disposed together with the
   * agent's scoped world — no manual disposer is needed or returned.
   */
  install(agentCtx: Context, sessionId: string, send: (text: string) => Promise<void>): void {
    agentCtx.on('approval/request', (req, next) => {
      const answer = this.requestApproval(sessionId, send, req)
      return answer ?? next()
    })
    agentCtx.on('user-questions/request', (request, next) => {
      const answer = this.requestQuestion(sessionId, send, request)
      return answer ?? next()
    })
  }

  /** Start an approval interaction; returns the promise to await, or `undefined` to delegate. */
  private requestApproval(
    sessionId: string,
    send: (text: string) => Promise<void>,
    req: ApprovalRequestEvent,
  ): Promise<ApprovalOutcome> | undefined {
    if (this.pending.has(sessionId)) return undefined // one at a time per session → delegate
    const prompt = [
      '【授权请求】Agent 需要执行以下操作，请回复确认：',
      `操作：${req.toolName ?? '(未知名工具)'}`,
      ...(req.reason ? [`说明：${req.reason}`] : []),
      '回复：Y 允许（仅本次） / N 拒绝',
    ].join('\n')

    return new Promise<ApprovalOutcome>((resolve) => {
      const record: PendingRecord = {
        kind: 'approval',
        send,
        tryAnswer: (text) => this.parseApprovalReply(text, resolve),
        abort: () => resolve('cancelled'),
      }
      this.pending.set(sessionId, record)
      this.attachAbort(req.signal, () => this.abortIfCurrent(sessionId, record))
      void this.sendPrompt(send, prompt, sessionId, () => this.delegateOnFailure(sessionId, record, () => resolve('unavailable')))
    })
  }

  /** Start a user-questions interaction; returns the promise to await, or `undefined` to delegate. */
  private requestQuestion(
    sessionId: string,
    send: (text: string) => Promise<void>,
    req: AskUserQuestionRequestEvent,
  ): Promise<AskUserQuestionAnswer> | undefined {
    if (this.pending.has(sessionId)) return undefined
    const questions = req.questions
    if (!Array.isArray(questions) || questions.length === 0) return undefined

    const prompt = this.renderQuestions(questions)
    return new Promise<AskUserQuestionAnswer>((resolve) => {
      const record: PendingRecord = {
        kind: 'question',
        send,
        tryAnswer: (text) => this.parseQuestionReply(questions, text, resolve),
        abort: () => resolve({ answers: [] }),
      }
      this.pending.set(sessionId, record)
      this.attachAbort(req.signal, () => this.abortIfCurrent(sessionId, record))
      void this.sendPrompt(send, prompt, sessionId, () => this.delegateOnFailure(sessionId, record, () => resolve({ answers: [] })))
    })
  }

  private renderQuestions(questions: readonly AskUserQuestionItem[]): string {
    const lines = ['【提问】请回答以下问题：']
    const multi = questions.length > 1
    questions.forEach((q, qi) => {
      lines.push(`${qi + 1}. ${q.question ?? '(未命名问题)'}${q.header ? ` [${q.header}]` : ''}`)
      const opts = q.options ?? []
      if (opts.length > 0) {
        opts.forEach((o, oi) => lines.push(`   ${oi + 1}. ${o.label}${o.description ? `（${o.description}）` : ''}`))
      } else {
        lines.push('   （直接输入你的回答）')
      }
    })
    lines.push(
      multi
        ? '回复格式：题号:选项，如「1:2」=第1题选第2项，多项用空格隔开；或直接输入文字（默认答第1题）。'
        : '可回复选项编号，或直接输入文字回答。',
    )
    return lines.join('\n')
  }

  private parseApprovalReply(text: string, resolve: (o: ApprovalOutcome) => void): boolean {
    const t = text.toLowerCase()
    if (/^(y|yes|允许|同意|确认|好的)$/.test(t)) {
      resolve('allowed-once')
      return true
    }
    if (/^(n|no|拒绝|不同意|取消|否)$/.test(t)) {
      resolve('rejected')
      return true
    }
    return false
  }

  private parseQuestionReply(
    questions: readonly AskUserQuestionItem[],
    text: string,
    resolve: (a: AskUserQuestionAnswer) => void,
  ): boolean {
    const t = text.trim()
    const answers: AskUserQuestionAnswerItem[] = []

    // Multi-question shorthand: "1:2 2:1" → q1 picks option index 2, q2 option 1.
    if (questions.length > 1 && /^(\d+):(\d+)(\s+\d+:\d+)*$/.test(t)) {
      for (const m of t.split(/\s+/)) {
        const [qq, oo] = m.split(':').map(Number)
        if (qq === undefined || qq < 1 || oo === undefined || oo < 1) return false
        const q = questions[qq - 1]
        if (q === undefined) return false
        const labels = (q.options ?? []).map((o) => o.label)
        const pick = labels[oo - 1]
        answers.push({ id: String(q.id), selected: pick !== undefined ? [pick] : [] })
      }
      resolve({ answers })
      return true
    }

    // Single question: bare number(s) select option index(es) (multiSelect allows "1,3").
    if (questions.length === 1 && /^[\d,\s]+$/.test(t)) {
      const q = questions[0]!
      const labels = (q.options ?? []).map((o) => o.label)
      const nums = [...new Set(t.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1))]
      const selected = nums.map((n) => labels[n - 1]).filter((l): l is string => l !== undefined)
      if (selected.length === 0) return false
      resolve({ answers: [{ id: String(q.id), selected }] })
      return true
    }

    // Free text → target the (single) first question.
    const first = questions[0]
    if (first !== undefined) {
      resolve({ answers: [{ id: String(first.id), selected: [], custom: t }] })
      return true
    }
    return false
  }

  private attachAbort(signal: AbortSignal | undefined, onAbort: () => void): void {
    if (signal === undefined) return
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  private abortIfCurrent(sessionId: string, record: PendingRecord): void {
    if (this.pending.get(sessionId) === record) {
      this.pending.delete(sessionId)
      record.abort()
    }
  }

  private delegateOnFailure(sessionId: string, record: PendingRecord, fallback: () => void): void {
    if (this.pending.get(sessionId) === record) {
      this.pending.delete(sessionId)
      fallback()
    }
  }

  private async sendPrompt(
    send: (text: string) => Promise<void>,
    prompt: string,
    sessionId: string,
    onFailure: () => void,
  ): Promise<void> {
    try {
      await send(prompt)
    } catch (error) {
      this.ctx.logger.warn(`[im-gateway] interaction prompt send for ${sessionId} failed: ${String(error)}`)
      onFailure()
    }
  }
}
