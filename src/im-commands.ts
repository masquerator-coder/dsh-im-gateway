/**
 * IM-side slash commands: `/status`, `/perm`, `/new`, `/help`.
 *
 * WHY THIS EXISTS. DSH's own `commands` registry is driven by UI clients: the
 * Web composer parses a line and calls `commands.execute(agent, line, …)`. An IM
 * message never touches that path — it arrives at `ImGateway.handle()`, which
 * feeds it to the model as ordinary text. So a command registered with
 * `ctx.commands.register()` is reachable from the Web GUI but NOT from a chat,
 * and typing `/perm` in WeChat would send the literal string to the model.
 *
 * This module is therefore two halves:
 *
 *  1. a router (`run`) the gateway calls BEFORE a message becomes a prompt, so
 *     a recognised command is consumed and never reaches the model;
 *  2. DSH command registrations for the same names, made in the scope of each
 *     IM agent the gateway composes — so the Web composer lists them for an IM
 *     session and NOT for an ordinary (non-IM) one. Both halves share one
 *     implementation per command.
 *
 * WHY PER-AGENT AND NOT GLOBAL. `commands` has no notion of a transport: a
 * definition registered from a plain (plugin-root) context is global, and
 * `commands.list(agent)` folds that global layer into EVERY agent's catalog.
 * Registering globally here is what used to put `/new`, `/status` and `/help`
 * in ordinary Web sessions, where they could only answer "IM 会话由聊天窗口的
 * /new 驱动". A definition registered through an agent's scoped context lands
 * in that agent's own layer instead (verified against cordis' service tracing
 * + `dsh-scope` in `scripts/smoke.mts`), and rides the agent's fiber, so it is
 * disposed with the agent.
 *
 * MODEL CONTEXT. Slash commands are deliberately outside the model's context.
 * The model-visible surface is exactly `system/message`, `developer/message`,
 * `user/message`, `assistant/message` and `tool/result`
 * (`@deepseek-ai/dsh-session`'s surface set); `command/run` and `command/done`
 * are not members, so neither a command line nor its result text is ever shown
 * to the model. The IM router preserves that property by RETURNING a reply
 * instead of injecting a prompt.
 *
 * `permissionPresets` and `commands` are mirrored structurally rather than
 * imported (the convention `interaction.ts` established): no peer package is
 * needed to type-check, and a profile without either bundle still loads.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/** Mirror of `CommandResult` from `@deepseek-ai/dsh-commands` (produced variants). */
type CommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** Mirror of `CommandInvocation` from `@deepseek-ai/dsh-commands` (consumed fields). */
interface CommandInvocation {
  readonly agent: Agent
  readonly rawInput: string
  readonly signal: AbortSignal
}

/** The subset of `permissionPresets` this module depends on. */
interface PermissionPresetLike {
  readonly names: readonly string[]
  current(session: Session): string
  set(session: Session, name: string): void
}

/** One registration argument accepted by the `commands` runtime (consumed fields). */
interface CommandDefinitionLike {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint?: string }
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

/** The subset of `commands` this module depends on. */
interface CommandRuntimeLike {
  register(definition: CommandDefinitionLike): () => void
}

/** Outcome of routing one IM message: either a reply, or "not a command". */
export type ImCommandOutcome =
  | { readonly kind: 'handled'; readonly text: string; readonly ok: boolean }
  | { readonly kind: 'pass' }

/** Per-chat session cursor: the overrides that make `sessionIdForChat` yield a new id. */
export interface ChatSessionState {
  /** Working directory override, or undefined for the configured default. */
  cwd?: string
  /** Rotation counter; 0 is the original session. */
  generation: number
}

/**
 * Mutable per-chat session cursors.
 *
 * IN-MEMORY BY DESIGN: the user chose a memory-only implementation, so a
 * restart returns every chat to its original session. That is stated in the
 * replies these commands produce, so the behaviour is never silent.
 */
export class SessionCursors {
  private readonly states = new Map<string, ChatSessionState>()

  /** Read the cursor for one chat, defaulting to the original session. */
  get(chatKey: string): ChatSessionState {
    return this.states.get(chatKey) ?? { generation: 0 }
  }

  /** Replace the cursor for one chat. */
  set(chatKey: string, state: ChatSessionState): void {
    if (state.generation === 0 && state.cwd === undefined) this.states.delete(chatKey)
    else this.states.set(chatKey, state)
  }

  /** Drop every cursor (used by tests and teardown). */
  clear(): void {
    this.states.clear()
  }
}

/**
 * Whether a user-supplied path is absolute.
 *
 * A RELATIVE path cannot be resolved here, and guessing would be worse than
 * refusing: the obvious reference point — the session's own working directory —
 * is exactly what is being changed, and it may be the configured default rather
 * than anything this chat chose. A Windows drive path, a UNC share and a POSIX
 * path are all absolute; anything else is refused with the reason.
 * (The harness requires a working directory to be absolute anyway, so this
 * mirrors the host's rule instead of inventing a second one.)
 * @param path - the trimmed user input.
 * @returns whether the path may be used as a working directory.
 */
function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('/') || path.startsWith('\\\\')
}

/** Split a command line into its name and verbatim remainder. */
export interface ImParsedCommand {
  readonly name: string
  readonly rawInput: string
}

/**
 * Parse an IM command line.
 *
 * Mirrors `@deepseek-ai/dsh-commands`' own grammar (a lowercase name followed by
 * end-of-line or whitespace), so IM and the Web GUI accept the same syntax.
 * @param line - the raw inbound text.
 * @returns the parsed command, or undefined when the text is not one.
 */
export function parseImCommand(line: string): ImParsedCommand | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
  if (match === null) return undefined
  const name = match[1]
  if (name === undefined) return undefined
  return { name, rawInput: line.slice(match[0].length) }
}

/** The gateway surfaces a command needs; kept narrow so this module stays testable. */
export interface CommandHost {
  readonly ctx: Context
  /** The live agent for a session id, when this host already holds one. */
  liveAgent(sessionId: string): Agent | undefined
}

/** Describe one preset as `name` plus, when resolvable, its knob bundle. */
function describe(name: string, specs: Readonly<Record<string, unknown>> | undefined): string {
  const spec = specs?.[name] as { sandbox?: string; approval?: string } | undefined
  if (spec === undefined) return name
  return `${name} (sandbox: ${spec.sandbox ?? '?'}, approval: ${spec.approval ?? '?'})`
}

/** Resolve the advertised preset names, plus specs when the service can supply them. */
function catalogOf(presets: PermissionPresetLike): {
  names: readonly string[]
  specs: Record<string, unknown> | undefined
} {
  const names = Array.isArray(presets.names) ? presets.names : []
  const withResolve = presets as PermissionPresetLike & {
    resolve?: (name: string) => { sandbox?: string; approval?: string }
  }
  if (typeof withResolve.resolve !== 'function') return { names, specs: undefined }
  const specs: Record<string, unknown> = {}
  for (const name of names) {
    try {
      specs[name] = withResolve.resolve(name)
    } catch {
      // A name that cannot resolve is still listable; skip only its detail.
    }
  }
  return { names, specs }
}

/** `/help` — the command list. */
function helpText(): string {
  return [
    '可用命令：',
    '  /status           查看本聊天的会话、工作目录与权限',
    '  /perm [preset]    查看或切换本会话的权限预设',
    '  /new [工作目录]    开启新会话（当前会话保留，不删除）；给了绝对路径就在该目录里开',
    '  /help             显示这份帮助',
    '',
    '命令不会进入模型上下文，模型看不到你输入的命令。',
  ].join('\n')
}

/**
 * Facts about the chat's CURRENT session, supplied by the gateway.
 *
 * These are computed by the caller (the gateway) because they are exactly the
 * values that decided which session the message was routed to — recomputing
 * them here could disagree with the routing decision, which is precisely what
 * `/status` must not do.
 */
export interface ImCommandContext {
  /** The session id this message was routed to. */
  readonly sessionId: string
  /** The effective working directory for this chat ('' when none configured). */
  readonly effectiveCwd: string
  /** Whether that directory came from `/new` rather than configuration. */
  readonly cwdFromCommand: boolean
  /** The live agent for this session, when one exists. */
  readonly liveAgent: Agent | undefined
}

/**
 * Bridge from an IM command line to the session cursor.
 *
 * `/perm` needs a live agent (it changes a session's permission); `/new`
 * changes the cursor that decides which session the NEXT message uses, so it
 * works even if no agent is live. `/status` needs neither.
 */
export class ImCommands {
  /** Agent contexts this instance already registered into (see `registerForAgent`). */
  private readonly installed = new WeakSet<Context>()

  /** `ctx` is injected so tests can supply a fixed service set without a live DSH. */
  constructor(
    private readonly ctx: Context,
    private readonly cursors: SessionCursors,
  ) {}

  /**
   * Route one inbound IM message.
   *
   * @param chatKey - stable per-chat key (channel + external chat id).
   * @param text - the raw inbound text.
   * @param context - the routed session's facts (id, cwd, live agent).
   * @returns `handled` with a reply, or `pass` when the text is not a command.
   */
  run(chatKey: string, text: string, context: ImCommandContext): ImCommandOutcome {
    const parsed = parseImCommand(text)
    if (parsed === undefined) return { kind: 'pass' }

    switch (parsed.name) {
      case 'help':
        return { kind: 'handled', ok: true, text: helpText() }
      case 'status':
        return this.runStatus(chatKey, context)
      case 'perm':
        return this.runPerm(parsed.rawInput, context.liveAgent)
      case 'new':
        return this.runNew(chatKey, parsed.rawInput, context)
      default:
        // An unknown `/name` is NOT swallowed: it may be a genuine message that
        // merely starts with a slash (a path, a fraction, a search string), and
        // eating it would lose user text. Pass it through to the model.
        return { kind: 'pass' }
    }
  }

  /**
   * `/status` — the one command that makes every OTHER one verifiable.
   *
   * It reports the session id the gateway actually routed to, so "did `/new`
   * work?" is answerable from the chat instead of by inspecting logs. Every
   * fact here is read from the caller-supplied context, never recomputed.
   */
  private runStatus(chatKey: string, context: ImCommandContext): ImCommandOutcome {
    const cursor = this.cursors.get(chatKey)
    const lines = [
      `会话 ID：${context.sessionId}`,
      `会话代次：${cursor.generation}${cursor.generation === 0 ? '（初始会话）' : '（由 /new 产生）'}`,
      `工作目录：${context.effectiveCwd || '(未设置)'}`,
      `目录来源：${context.cwdFromCommand ? '/new 设置' : (context.effectiveCwd === '' ? '无' : '配置默认值')}`,
      `Agent 状态：${context.liveAgent === undefined ? '未启动（下一条消息会创建）' : '运行中'}`,
    ]

    const presets = this.ctx.get('permissionPresets') as PermissionPresetLike | undefined
    if (presets === undefined) {
      lines.push('权限预设：不可用（未加载 permission-presets）')
    } else if (context.liveAgent === undefined) {
      lines.push('权限预设：未知（本会话尚无 agent）')
    } else {
      const session = (context.liveAgent as Agent & { session: Session }).session
      try {
        lines.push(`权限预设：${presets.current(session)}`)
      } catch {
        lines.push('权限预设：读取失败')
      }
    }

    lines.push('', '提示：重启 DSH 后会话代次与 /new 设置的工作目录会重置。')
    return { kind: 'handled', ok: true, text: lines.join('\n') }
  }

  /** `/perm` — inspect or switch the current session's permission preset. */
  private runPerm(rawInput: string, liveAgent: Agent | undefined): ImCommandOutcome {
    const presets = this.ctx.get('permissionPresets') as PermissionPresetLike | undefined
    if (presets === undefined) {
      return { kind: 'handled', ok: false, text: '权限预设不可用：未加载 permission-presets。' }
    }
    const { names, specs } = catalogOf(presets)
    if (names.length === 0) {
      return { kind: 'handled', ok: false, text: '本部署未配置任何权限预设。' }
    }

    const requested = rawInput.trim()
    if (liveAgent === undefined) {
      // Listing still works (it needs no session); switching needs one.
      if (requested === '') {
        return {
          kind: 'handled',
          ok: true,
          text: ['尚未为本会话建立运行中的 agent，因此不显示当前值。', '', '可用预设：',
            ...names.map(name => `  ${describe(name, specs)}`)].join('\n'),
        }
      }
      return { kind: 'handled', ok: false, text: '本会话尚未启动 agent，无法切换权限。请先发一条普通消息。' }
    }

    const session = (liveAgent as Agent & { session: Session }).session
    if (requested === '') {
      let current: string
      try {
        current = presets.current(session)
      } catch {
        current = 'unknown'
      }
      const others = names.filter(name => name !== current)
      const lines = [
        `当前权限预设：${current}`,
        '',
        '可用：',
        ...names.map(name => `${name === current ? '* ' : '  '}${describe(name, specs)}`),
      ]
      if (others.length > 0) lines.push('', `切换：/perm ${others[0]}`)
      return { kind: 'handled', ok: true, text: lines.join('\n') }
    }

    // Reject an unknown name BEFORE set(), which throws on one.
    if (!names.includes(requested)) {
      return {
        kind: 'handled',
        ok: false,
        text: `未知权限预设 "${requested}"。\n可用：${names.join(', ')}`,
      }
    }
    try {
      presets.set(session, requested)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return { kind: 'handled', ok: false, text: `切换到 "${requested}" 失败：${detail}` }
    }
    const spec = specs?.[requested] as { sandbox?: string; approval?: string } | undefined
    const detail = spec === undefined ? '' : `（sandbox: ${spec.sandbox ?? '?'}, approval: ${spec.approval ?? '?'}）`
    this.ctx.logger.info(`[im-gateway] /perm -> "${requested}" for ${session.id}`)
    return { kind: 'handled', ok: true, text: `权限预设已切换为 ${requested}${detail}。` }
  }

  /**
   * `/new [工作目录]` — rotate to a fresh session for this chat, optionally in
   * another directory.
   *
   * Both halves are the SAME operation: `sessionIdForChat` hashes
   * (channel, chatId, cwd) plus a generation prefix, so starting a new
   * conversation and moving that conversation to another directory are one
   * edit of one cursor. (This is why the retired `/cwd` command existed at
   * all: switching directory cannot mutate a live session — DSH pins a
   * session's cwd at creation — so it always meant "start a new one here".
   * One command that says what it does replaces two that had to explain
   * themselves to each other.)
   *
   * A path that is not absolute is REFUSED rather than guessed: the natural
   * reference point would be the session's own directory, which is the very
   * thing being changed.
   */
  private runNew(chatKey: string, rawInput: string, context: ImCommandContext): ImCommandOutcome {
    const current = this.cursors.get(chatKey)
    const requested = rawInput.trim()

    // No directory given: keep whatever this chat had (a `/cwd`-era cursor, the
    // configured default, or nothing) and only rotate the generation — a plain
    // `/new` must never quietly move a chat out of its workspace.
    if (requested === '') {
      const next: ChatSessionState = {
        generation: current.generation + 1,
        ...(current.cwd === undefined ? {} : { cwd: current.cwd }),
      }
      this.cursors.set(chatKey, next)
      const where = next.cwd === undefined ? '' : `\n工作目录仍为：${next.cwd}`
      return {
        kind: 'handled',
        ok: true,
        text: [
          `已开启新会话（第 ${next.generation} 次）。下一条消息将在全新会话中进行。`,
          `切换前会话：${context.sessionId}`,
          '之前的会话记录仍保留，未被删除。',
          '注意：服务重启后此计数会重置，本聊天将回到最初的会话。',
        ].join('\n') + where,
      }
    }

    if (!isAbsolutePath(requested)) {
      return {
        kind: 'handled',
        ok: false,
        text: `请提供绝对路径，例如：/new D:\\项目\\foo\n收到：${requested}`,
      }
    }

    const next: ChatSessionState = { generation: current.generation + 1, cwd: requested }
    this.cursors.set(chatKey, next)
    return {
      kind: 'handled',
      ok: true,
      text: [
        `工作目录已设为：${requested}`,
        `已在新目录开启新会话（第 ${next.generation} 次）。下一条消息在新会话中进行。`,
        `切换前会话：${context.sessionId}`,
        'DSH 会话的工作目录在创建时固定、无法迁移，因此这里是"在新目录重新开始"。',
        '注意：服务重启后此设置会重置，本聊天将回到最初的会话与目录。',
      ].join('\n'),
    }
  }

  /**
   * Register the same commands in ONE IM agent's scope.
   *
   * WHY SCOPED, NOT GLOBAL. `commands.list(agent)` folds the global layer into
   * every agent's catalog, so a plugin-root registration is listed in EVERY
   * session — including ordinary Web sessions that never touched an IM channel,
   * where these names could only answer "IM 会话由聊天窗口的 /new 驱动".
   * Registering through the agent's own scoped context (the one `setup()`
   * receives) puts the definitions in that agent's layer instead: an ordinary
   * session's agent never sees them, an IM agent does, and they are disposed
   * with the agent because the registry attaches them to its fiber.
   *
   * The IM router is what makes them work from a chat; this half only makes
   * them discoverable in the Web composer for the session they belong to.
   *
   * Idempotent per agent context: `setup()` runs once per created/resumed
   * agent, but the gateway also installs on a live agent it adopts from another
   * entry point, and a second registration in one scope would throw.
   * @param agentCtx - the receiving agent's scoped context.
   */
  registerForAgent(agentCtx: Context): void {
    if (this.installed.has(agentCtx)) return
    const commands = agentCtx.get('commands') as CommandRuntimeLike | undefined
    if (commands === undefined || typeof commands.register !== 'function') {
      this.ctx.logger.debug('[im-gateway] commands not registered: the commands service is unavailable')
      return
    }
    for (const definition of this.definitions()) {
      try {
        commands.register(definition)
      } catch (error: unknown) {
        // A name already taken in this agent's scope (an agent preset that
        // ships its own `/new`, say) must not abort the agent's setup: the IM
        // router still serves the chat. Name the dropped command rather than
        // losing it silently.
        const detail = error instanceof Error ? error.message : String(error)
        this.ctx.logger.warn(`[im-gateway] /${definition.name} not listed for this agent: ${detail}`)
      }
    }
    this.installed.add(agentCtx)
  }

  /** The Web-composer faces of the IM commands, one definition per name. */
  private definitions(): readonly CommandDefinitionLike[] {
    return [
      {
        name: 'perm',
        description: "Show or switch this session's permission preset (sandbox + approval).",
        input: { hint: '[preset]' },
        handler: (invocation) => {
          const session = (invocation.agent as Agent & { session: Session }).session
          return this.permForSession(session, invocation.rawInput)
        },
      },
      {
        name: 'new',
        description: 'Start a new session for this chat, optionally in a given working directory.',
        input: { hint: '[absolute path]' },
        handler: () => ({ kind: 'success', text: 'IM 会话由聊天窗口的 /new [工作目录] 驱动；Web 端请直接新建会话（切换工作区请直接在 Web 端切换）。' }),
      },
      {
        name: 'help',
        description: 'List the IM gateway commands.',
        handler: () => ({ kind: 'success', text: helpText() }),
      },
      {
        name: 'status',
        description: 'Show this chat\'s session id, working directory and permission.',
        handler: () => ({
          kind: 'success',
          text: 'IM 会话状态由聊天窗口的 /status 驱动（需要聊天上下文的会话信息）。',
        }),
      },
    ]
  }

  /** `/perm` against an explicit session (the Web-composer path). */
  private permForSession(session: Session, rawInput: string): CommandResult {
    const presets = this.ctx.get('permissionPresets') as PermissionPresetLike | undefined
    if (presets === undefined) {
      return { kind: 'error', text: 'Permission presets are unavailable.' }
    }
    const { names, specs } = catalogOf(presets)
    if (names.length === 0) return { kind: 'error', text: 'No permission presets are configured.' }
    const requested = rawInput.trim()
    if (requested === '') {
      let current: string
      try {
        current = presets.current(session)
      } catch {
        current = 'unknown'
      }
      return {
        kind: 'success',
        text: [`Current permission preset: ${current}`, '', 'Available:',
          ...names.map(name => `${name === current ? '* ' : '  '}${describe(name, specs)}`)].join('\n'),
      }
    }
    if (!names.includes(requested)) {
      return { kind: 'error', text: `Unknown permission preset "${requested}".\nAvailable: ${names.join(', ')}` }
    }
    try {
      presets.set(session, requested)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return { kind: 'error', text: `Could not switch to "${requested}": ${detail}` }
    }
    return { kind: 'success', text: `Permission preset switched to ${requested}.` }
  }
}