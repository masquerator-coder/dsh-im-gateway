/**
 * Host-write helper for the IM-channel settings panel.
 *
 * WHY THIS IS ITS OWN MODULE: the panel lives in a `.tsx` file, which
 * `node --experimental-transform-types` (how `scripts/smoke.mts` runs) cannot
 * load. Keeping this one function JSX-free lets the smoke suite import and
 * exercise it directly — and the behaviour it encodes is exactly the kind that
 * fails SILENTLY in production, so it needs a real test rather than a string
 * match against the built bundle.
 */

import type { ChannelsForm } from './settings-form.ts'

/**
 * Write one field through the bound form, turning a REFUSED write into a throw.
 *
 * `ConfigForm.set` resolves `false` when the Host rejects the write (a revision
 * conflict, a plugin entry that is no longer configurable, or a section an
 * overlay shadows) and only REJECTS on a transport failure. Awaiting it without
 * inspecting the result therefore treats "the Host refused to save" exactly like
 * success: the panel reported 已保存, cleared the create form, and — with the
 * channel list still empty — fell back to the "尚未配置任何通道" empty state.
 * That made every refused write look like "the QR never appeared".
 *
 * Every write in the panel goes through here so a refusal surfaces as the red
 * 保存失败 notice instead of a silent no-op.
 *
 * @param form - the bound settings form.
 * @param field - field name inside the plugin's config section.
 * @param value - JSON-shaped value to store.
 * @param t - locale lookup for the refusal message.
 * @throws when the Host does not accept the write.
 */
export async function writeField(
  form: Pick<ChannelsForm, 'set'>,
  field: string,
  value: unknown,
  t: (key: string) => string,
): Promise<void> {
  const accepted = await form.set(field, value)
  if (!accepted) throw new Error(t('channels.writeRefused'))
}