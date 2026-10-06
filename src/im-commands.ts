/**
 * IM-side slash commands: `/perm`, `/new`, `/cwd`, `/help`.
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
 *  1. a router (`runImCommand`) the gateway calls BEFORE a message becomes a
 *     prompt, so a recognised command is consumed and never reaches the model;
 *  2. DSH command registrations for the same names, so the Web GUI lists them
 *     too. Both halves share one implementation per command.
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

/** The subset of `commands` this module depends on. */
interface CommandRuntimeLike {
  register(definition: {
    name: string
    description: string
    input?: { hint?: string }
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
  }): () => void
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
    '  /new              开启新会话（当前会话保留，不删除）',
    '  /cwd [path]       查看或切换工作目录（在新目录开新会话）',
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
  /** Whether that directory came from `/cwd` rather than configuration. */
  readonly cwdFromCommand: boolean
  /** The live agent for this session, when one exists. */
  readonly liveAgent: Agent | undefined
}

/**
 * Bridge from an IM command line to the session cursor.
 *
 * `/perm` needs a live agent (it changes a session's permission); `/new` and
 * `/cwd` change the cursor that decides which session the NEXT message uses, so
 * they work even if no agent is live. `/status` needs neither.
 */
export class ImCommands {
  /** Injected so tests can supply a fixed reply set without a live DSH. */
  constructor(
    private readonly ctx: Context,
    private readonly cursors: SessionCursors,
    private readonly defaultsCwd: () => string,
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
        return this.runNew(chatKey, context)
      case 'cwd':
        return this.runCwd(chatKey, parsed.rawInput)
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
      `会话代次：${cursor.generation}${cursor.generation === 0 ? '（初始会话）' : '（由 /new 或 /cwd 产生）'}`,
      `工作目录：${context.effectiveCwd || '(未设置)'}`,
      `目录来源：${context.cwdFromCommand ? '/cwd 设置' : (context.effectiveCwd === '' ? '无' : '配置默认值')}`,
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

    lines.push('', '提示：重启 DSH 后会话代次与 /cwd 设置会重置。')
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

  /** `/new` — rotate to a fresh session for this chat. */
  private runNew(chatKey: string, context: ImCommandContext): ImCommandOutcome {
    const current = this.cursors.get(chatKey)
    const next: ChatSessionState = { generation: current.generation + 1, ...(current.cwd === undefined ? {} : { cwd: current.cwd }) }
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

  /** `/cwd` — inspect or switch the working directory. */
  private runCwd(chatKey: string, rawInput: string): ImCommandOutcome {
    const requested = rawInput.trim()
    const current = this.cursors.get(chatKey)
    const effective = current.cwd ?? this.defaultsCwd()

    if (requested === '') {
      return {
        kind: 'handled',
        ok: true,
        text: [
          `当前工作目录：${effective || '(未设置)'}`,
          current.cwd === undefined ? '（来自配置的默认值）' : '（由 /cwd 设置）',
          '',
          '切换：/cwd <绝对路径>',
        ].join('\n'),
      }
    }

    // A relative path is ambiguous once the session's own cwd is the reference,
    // and DSH pins a session's cwd at creation, so require an absolute one and
    // say so rather than guessing.
    const isAbsolute = /^[A-Za-z]:[\\/]/u.test(requested) || requested.startsWith('/') || requested.startsWith('\\\\')
    if (!isAbsolute) {
      return {
        kind: 'handled',
        ok: false,
        text: `请提供绝对路径，例如：/cwd D:\\项目\\foo\n收到：${requested}`,
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
        'DSH 会话的工作目录在创建时固定、无法迁移，因此这里是"在新目录重新开始"。',
        '注意：服务重启后此设置会重置，本聊天将回到最初的会话与目录。',
      ].join('\n'),
    }
  }

  /**
   * Register the same commands with DSH's registry, so the Web GUI lists them.
   *
   * The IM router is what makes them work from a chat; this half only makes
   * them discoverable (and usable) in the Web composer.
   * @returns the disposer, or undefined when the `commands` service is absent.
   */
  registerWithHost(): (() => void) | undefined {
    const commands = this.ctx.get('commands') as CommandRuntimeLike | undefined
    if (commands === undefined || typeof commands.register !== 'function') {
      this.ctx.logger.debug('[im-gateway] commands not registered: the commands service is unavailable')
      return undefined
    }
    const disposers = [
      commands.register({
        name: 'perm',
        description: "Show or switch this session's permission preset (sandbox + approval).",
        input: { hint: '[preset]' },
        handler: (invocation) => {
          const session = (invocation.agent as Agent & { session: Session }).session
          const result = this.permForSession(session, invocation.rawInput)
          return result
        },
      }),
      commands.register({
        name: 'new',
        description: 'Start a new session for this chat (the previous one is kept).',
        handler: () => ({ kind: 'success', text: 'IM 会话由聊天窗口的 /new 驱动；Web 端请直接新建会话。' }),
      }),
      commands.register({
        name: 'cwd',
        description: 'Show or switch the working directory for this chat.',
        input: { hint: '[path]' },
        handler: () => ({ kind: 'success', text: 'IM 工作目录由聊天窗口的 /cwd 驱动；Web 端请直接切换工作区。' }),
      }),
      commands.register({
        name: 'help',
        description: 'List the IM gateway commands.',
        handler: () => ({ kind: 'success', text: helpText() }),
      }),
      commands.register({
        name: 'status',
        description: 'Show this chat\'s session id, working directory and permission.',
        handler: () => ({
          kind: 'success',
          text: 'IM 会话状态由聊天窗口的 /status 驱动（需要聊天上下文的会话信息）。',
        }),
      }),
    ]
    return this.ctx.effect(
      () => () => { for (const dispose of disposers) dispose() },
      'dsh-im-gateway.commands()',
    )
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