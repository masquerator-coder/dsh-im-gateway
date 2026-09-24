/**
 * Front-end required-field validation for the IM-channel settings panel.
 *
 * WHY THIS IS ITS OWN MODULE: the panel lives in a `.tsx` file, which
 * `node --experimental-transform-types` (how `scripts/smoke.mts` runs) cannot
 * load. Keeping this rule JSX-free lets the smoke suite exercise it directly —
 * which matters because the bug it fixes fails SILENTLY: an over-strict check
 * does not crash, it just makes every already-configured channel unsavable.
 * Same reason and same shape as `./write-field.ts`.
 */

import type { ChannelType } from '../channels/types.ts'

/** One editable field of a channel, keyed by the schema field name. */
export interface Field {
  key: string
  labelKey: string
  secret?: boolean
  placeholder?: string
}

/** Per-type prefill template + field list (the "傻瓜式" defaults). */
export interface Template {
  defaults: Record<string, unknown>
  fields: Field[]
}

/** Non-secret fields that must be present before a channel can be saved. */
export const REQUIRED_BY_TYPE: Partial<Record<ChannelType, string[]>> = {
  email: ['account'],
  http: ['callbackUrl'],
  feishu: ['appId'],
  // The QQ robot cannot even fetch an access token without both; AppSecret is a
  // secret field (required implicitly: an empty secret box on a NEW channel is
  // reported as missing) and the AppID is required explicitly here.
  qq: ['appId'],
}

/**
 * Front-end required-field check before save. Returns the labelKey of the
 * first missing field, or null when the record is complete.
 *
 * SECRETS ARE ONLY REQUIRED WHEN CREATING. A stored secret can never be seen
 * here — not its value, and not even its presence: the Host runs every wire
 * layer through `redactSecrets`, which returns `undefined` for a
 * `role('secret')` node and then drops the key entirely (DSH
 * `settings/settings/src/redact.ts:53-70`), and that redaction is applied to
 * `value`, `base` AND `user` alike (`settings/settings/src/index.ts:323-329`).
 * The `{path, set}` existence list the Host does compute is not exposed on
 * `ConfigForm` (`ui-settings/src/client/config-form-types.ts:39-77`), which
 * carries only value/base/user/revision/writable/mode.
 *
 * So on an EDIT the client cannot tell "secret stored, box left blank to keep
 * it" from "secret never set". Requiring it made every already-configured
 * channel unsavable: the user was shown 缺少必填项 for a field they genuinely
 * could not fill without retyping a credential they only wanted to keep. A
 * blank secret on edit therefore means KEEP — which is exactly what the merge
 * in the panel already implements (`if (f.secret) continue // keep stored
 * secret`). Creation still demands it.
 *
 * @param type - the channel kind being edited.
 * @param template - that kind's field list.
 * @param editing - true when an existing channel is being edited (not created).
 * @param draft - current form values, keyed by field name.
 * @param provider - selected email provider id (custom requires a host).
 * @returns the labelKey of the first missing field, or null when complete.
 */
export function requiredMissing(
  type: ChannelType,
  template: Template | undefined,
  editing: boolean,
  draft: Record<string, string>,
  provider: string,
): string | null {
  const missing: string[] = []
  for (const f of template?.fields ?? []) {
    if (f.secret) {
      if (!editing && !(draft[f.key] ?? '').trim()) missing.push(f.labelKey)
      continue
    }
    const required = (REQUIRED_BY_TYPE[type] ?? []).includes(f.key)
    if (required && !(draft[f.key] ?? '').trim()) missing.push(f.labelKey)
  }
  // A custom email provider needs an explicit server host (presets fill it).
  if (type === 'email' && provider === 'custom' && !(draft.host ?? '').trim()) missing.push('field.host')
  return missing.length > 0 ? missing[0]! : null
}