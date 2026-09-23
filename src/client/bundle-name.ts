/**
 * The Plugins page's dispatch key for this plugin's configuration entry.
 *
 * Lives in its own JSX-free module because two callers need it: the client half
 * (`./index.ts`) keys its `plugins.bundle.config` registration with it, and the
 * smoke test asserts it equals `package.json`'s `name` — a `.tsx` module cannot
 * be loaded by `node --experimental-transform-types`, which is how the smoke
 * test runs.
 *
 * WHY IT MATTERS: the Plugins page resolves a bundle's configuration with
 * `entries.find(entry => entry.options.key === pkg.name)`, so a key that drifts
 * from the package name makes the panel silently disappear (no error, no
 * console line — the entry is simply never dispatched).
 */

/** Must equal `package.json`'s `name` verbatim. Asserted by the smoke test. */
export const BUNDLE_NAME = 'dsh-im-gateway'

/**
 * This plugin's profile loader ENTRY id — the `id:` of the row this bundle's
 * `cordis.patch.yml` inserts (and the id a user's own patch would target).
 *
 * DSH 0.1.7 removed the plugin-registrable settings namespace, so the client
 * panel can no longer ask for a namespace it named itself: it must ask
 * `configForms.get()` for the plugin's own entry. Must stay in step with
 * `cordis.patch.yml` and `cordis.yml`. Asserted by the smoke test.
 */
export const ENTRY_ID = 'im-gateway'