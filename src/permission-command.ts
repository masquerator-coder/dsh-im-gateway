/**
 * `/perm` — inspect and switch the calling session's permission preset.
 *
 * WHY THIS LIVES HERE: the gateway used to force
 * `permissionPresets.defaultPreset` onto every agent it created, which made a
 * per-session choice impossible to express. That overwrite is gone (a preset is
 * now applied only when explicitly configured), so a session can finally be
 * switched at runtime — but nothing in the IM surface could *make* that switch.
 * This command closes the loop.
 *
 * The handler runs against `invocation.agent`, i.e. the exact session that
 * received the command line, so a switch affects one chat and never leaks into
 * another.
 *
 * `permissionPresets`, `commands` and the command payload types are mirrored
 * structurally rather than imported, following the same convention as
 * `interaction.ts`: this plugin needs no peer package installed merely to
 * type-check, and neither service is guaranteed to be loaded. Every access is
 * therefore optional and degrades to a no-op (registration) or a typed error
 * (invocation).
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

/** The subset of `permissionPresets` this command depends on. */
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

/** Command name, without the leading slash. */
export const PERM_COMMAND = 'perm'

/** Lowercase name the tests and the help text both key off. */
const USAGE = 'Usage: /perm [preset]   (no argument lists the available presets)'

/** Describe one preset as `name` plus, when resolvable, its knob bundle. */
function describe(name: string, specs: Readonly<Record<string, unknown>> | undefined): string {
  const spec = specs?.[name] as { sandbox?: string; approval?: string } | undefined
  if (spec === undefined) return name
  const sandbox = spec.sandbox ?? '?'
  const approval = spec.approval ?? '?'
  return `${name} (sandbox: ${sandbox}, approval: ${approval})`
}

/**
 * Resolve the preset catalog for messaging.
 *
 * `names` is the advertised list; `resolve` is optional because a service that
 * exposes the names but not the specs should still list them.
 * @param presets - the live service.
 * @returns the advertised names in declaration order, plus resolved specs when available.
 */
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

/**
 * Build the `/perm` handler.
 * @param ctx - plugin context, used for the optional preset service and logging.
 * @returns the command handler.
 */
function makeHandler(ctx: Context) {
  return (invocation: CommandInvocation): CommandResult => {
    const presets = ctx.get('permissionPresets') as PermissionPresetLike | undefined
    if (presets === undefined) {
      return {
        kind: 'error',
        text: 'Permission presets are unavailable: the `permission-presets` bundle is not loaded.',
      }
    }

    const { names, specs } = catalogOf(presets)
    if (names.length === 0) {
      return { kind: 'error', text: 'No permission presets are configured for this deployment.' }
    }

    const agent = invocation.agent as Agent & { session: Session }
    const session = agent.session
    const requested = invocation.rawInput.trim()

    // No argument: report the current preset and what else is available.
    if (requested === '') {
      let current: string
      try {
        current = presets.current(session)
      } catch {
        current = 'unknown'
      }
      const others = names.filter(name => name !== current)
      const lines = [
        `Current permission preset: ${current}`,
        '',
        'Available:',
        ...names.map(name => `${name === current ? '* ' : '  '}${describe(name, specs)}`),
      ]
      if (others.length > 0) {
        lines.push('', `Switch with: /perm ${others[0]}`)
      }
      return { kind: 'success', text: lines.join('\n') }
    }

    // Reject an unknown name BEFORE calling set(), which throws on one.
    if (!names.includes(requested)) {
      return {
        kind: 'error',
        text: `Unknown permission preset "${requested}".\nAvailable: ${names.join(', ')}\n\n${USAGE}`,
      }
    }

    try {
      presets.set(session, requested)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return { kind: 'error', text: `Could not switch to "${requested}": ${detail}` }
    }

    const spec = specs?.[requested] as { sandbox?: string; approval?: string } | undefined
    const detail = spec === undefined
      ? ''
      : ` (sandbox: ${spec.sandbox ?? '?'}, approval: ${spec.approval ?? '?'})`
    ctx.logger.info(`[im-gateway] permission preset switched to "${requested}" for ${session.id}`)
    return { kind: 'success', text: `Permission preset switched to ${requested}${detail}.` }
  }
}

/**
 * Register the `/perm` command for this plugin's lifetime.
 *
 * A no-op when the `commands` service is absent, so a profile without that
 * bundle still loads the gateway.
 * @param ctx - plugin context.
 * @returns the disposer, or undefined when nothing was registered.
 */
export function registerPermCommand(ctx: Context): (() => void) | undefined {
  const commands = ctx.get('commands') as CommandRuntimeLike | undefined
  if (commands === undefined || typeof commands.register !== 'function') {
    ctx.logger.debug('[im-gateway] /perm not registered: the commands service is unavailable')
    return undefined
  }

  const handler = makeHandler(ctx)
  return ctx.effect(
    () => commands.register({
      name: PERM_COMMAND,
      description: 'Show or switch this session\'s permission preset (sandbox + approval).',
      input: { hint: '[preset]' },
      handler,
    }),
    'dsh-im-gateway.perm-command()',
  )
}