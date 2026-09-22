/**
 * The `im-channels` settings namespace and the client-side form face the panel
 * binds to.
 *
 * WHY THIS MODULE EXISTS: two React modules need these types (`ChannelsCard`
 * and `ChannelsSection`) but neither may import the plugin entry
 * (`./index.ts`) — that would form a cycle, since the entry imports the card to
 * register it. This is the JSX-free leaf both can depend on.
 *
 * WHY THE FACE IS DECLARED STRUCTURALLY: the real declaration is `ConfigForm<T>`
 * in `@deepseek-ai/dsh-client-ui-settings/client`, which is not installed in
 * this repo (the DSH web runtime provides it at load time — see
 * ./dsh-stubs.d.ts). Declaring the three members this bundle calls keeps a
 * standalone `tsc` honest about the shape without depending on the package.
 *
 * HISTORY: this replaced the `settingsScope` service, which DSH 0.1.7-alpha.1
 * deleted when it rewrote settings as a profile-owned live Config plus a form
 * projection. The old scope exposed `getSnapshot` / `subscribe` / `set`; so
 * does `ConfigForm`, so the panel body itself needed no rewrite.
 */

import type { ChannelConfig } from '../channels/types.ts'

/** The `im-channels` settings namespace this bundle owns. */
export interface ChannelsSettings {
  /** Every configured channel, in display order. */
  channels: ChannelConfig[]
  /** Plugin-wide default working directory (set on the card). */
  cwd?: string
}

/**
 * The subset of `ConfigForm<ChannelsSettings>` this bundle consumes.
 *
 * `ConfigForm` is generic over the section type; this pins it to
 * {@link ChannelsSettings} so callers read `value.channels` without a cast.
 */
export interface ChannelsForm {
  /**
   * Current sync snapshot (stable reference until the next change).
   * @returns the accepted section, `undefined` before the first acceptance.
   */
  getSnapshot(): ChannelsSettingsSnapshot
  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void
  /**
   * Queue one field write.
   * @param field - scalar field inside the namespace section.
   * @param value - JSON-shaped value selected by the user.
   * @returns whether the Host accepted the write.
   */
  set(field: string, value: unknown): Promise<boolean>
}

/** The members of `ConfigFormSnapshot` this bundle reads. */
export interface ChannelsSettingsSnapshot {
  /** `loading` until the first accepted section, `ready` while one stands. */
  status?: 'loading' | 'ready' | 'unavailable'
  /** Last accepted schema-resolved section; `undefined` before the first. */
  value: ChannelsSettings | undefined
  /** Whether the Host document accepts writes. */
  writable?: boolean
}